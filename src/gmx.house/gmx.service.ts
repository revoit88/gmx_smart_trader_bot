import { Injectable } from '@nestjs/common';
import { Status, Trade, getBuiltGraphSDK } from '../../.graphclient';

import { EventEmitter2 } from '@nestjs/event-emitter';
import * as _ from 'lodash';
import { POSITION_CLOSED, POSITION_CLOSED_ALL, POSITION_OPEN, POSITION_UPDATED, TOKEN_SYMBOL } from 'src/common/constants';
import { Logger } from 'src/logger/logger.service';
import { CEXTrade, GMXTrade, IPositionDecrease, IPositionIncrease, ITrade, TradeEvent } from 'src/interfaces/gmx.interface';
import { getOrderedActionList, isTradeClosed, isTradeOpen } from 'src/middleware/gmx/gmx.middleware';
import * as diff from 'fast-array-diff';

@Injectable()
export class GMXService {
  // binance 交易所仓位
  private bnTradeList: CEXTrade[] = [];
  private _isWatching = false;

  private sdk = getBuiltGraphSDK();

  private _lastQueryTrades: GMXTrade[] | undefined;

  private startWatch = false;

  private _watchingInfo: {
    account: string | undefined;
    status: string | undefined;
  } = {
    account: undefined,
    status: undefined,
  };

  constructor(private readonly logger: Logger, private eventEmitter: EventEmitter2) {}

  get activeTrades() {
    return this._lastQueryTrades;
  }

  get isWatching() {
    return this._isWatching;
  }

  get watchingInfo() {
    return this._watchingInfo;
  }

  async watchAccountTradeList(account: string, status: Status) {
    this._watchingInfo = { account: account, status: status };
    this.startWatch = true;
    this._isWatching = true;

    const result = await this.sdk.AccountTradeList({
      account: account,
      status: status,
    });

    for await (const query of result) {
      if (!this.startWatch) {
        break;
      }

      const activeTrades = query.trades;
      // 1. trader 没有仓位则清空 binance 所有仓位。
      if (!this._lastQueryTrades && _.isEmpty(activeTrades)) {
        this.notifyCloseAllTrade();
      } else {
        const changes = diff.diff(this._lastQueryTrades ?? [], activeTrades, this.tradesCompare);
        const noChanges = _.isEmpty(changes.added) && _.isEmpty(changes.removed);
        const hasChanges = !noChanges;
        const hasClosePosition = activeTrades.length > 0 && activeTrades.length < (this._lastQueryTrades ?? []).length;

        if (hasClosePosition) {
          // 某个仓位被关闭了。
          changes.removed.forEach((trade) => {
            const symbol = TOKEN_SYMBOL.get(trade.indexToken);
            if (!symbol) {
              this.logger.warn(`参数异常， 没有 symbol，当前 trade 为 ${JSON.stringify(trade)}`);
              return;
            }

            const pair = symbol + 'USDT';
            this.notifyClosePosition(trade, symbol, pair);
          });
        } else if (_.isEmpty(activeTrades) && hasChanges) {
          this.notifyCloseAllTrade();
        } else if (hasChanges) {
          query.trades.forEach((trade) => this.diffTrade(trade));
        }
      }

      this._lastQueryTrades = query.trades;
    }
  }

  // 所有仓位平仓
  notifyCloseAllTrade() {
    this.eventEmitter.emit(POSITION_CLOSED_ALL);
    this.bnTradeList = [];
    this.logger.log('发出 POSITION_CLOSED_ALL 事件');
  }

  private diffTrade(trade: ITrade) {
    const symbol = TOKEN_SYMBOL.get(trade.indexToken);
    if (!symbol) {
      this.logger.warn(`参数异常， 没有 symbol，当前 trade 为 ${JSON.stringify(trade)}`);
      return;
    }

    const pair = symbol + 'USDT';
    const bnTrade = _.find(this.bnTradeList, { symbol: symbol });
    this.logger.debug(`当前 bnTradeList: ${JSON.stringify(this.bnTradeList)}`);

    const actionList = getOrderedActionList(trade);

    if (!actionList) {
      if (trade.updateList.length > 0) {
        this.logger.warn(`actionList 不应该为空，当前 trade 数据为: ${JSON.stringify(trade)}`);
      }
      return;
    }

    if (isTradeOpen(trade)) {
      const action = _.head(actionList);

      if (bnTrade) {
        this.logger.warn(`特殊情况，想要开仓但 binance 已包含已包含 ${pair} 仓位.`);
        return;
      }

      if (!action) {
        this.logger.warn('异常情况，应该有 action，但是没有。');
        return;
      }

      const newTrade = { symbol: symbol, openTimestamp: trade.timestamp, actions: actionList, pair: pair };
      const event: TradeEvent = {
        trade: newTrade,
        updateAction: action,
        raw: trade,
      };

      this.logger.log('发出 POSITION_OPEN 事件');
      this.eventEmitter.emit(POSITION_OPEN, event);

      this.bnTradeList.push(newTrade);
      this.logger.debug(`bnTradeList: ${JSON.stringify(this.bnTradeList)}`);
    } else if (isTradeClosed(trade)) {
      if (!trade.closedPosition) {
        this.logger.warn('异常情况，应该有 closedPosition.');
        return;
      }

      this.notifyClosePosition(trade, symbol, pair);
    } else {
      if (!bnTrade) {
        this.logger.warn('想要更新仓位，但监控到 trader 仓位存在， 但服务器没有记录，请手动酌情开启自己的仓位。');
        return;
      }

      // 调仓
      const lastActionList = bnTrade?.actions;
      const changes = diff.diff(lastActionList, actionList, this.actionCompare);
      const action = _.head(changes.added);

      if (!action) {
        this.logger.warn(
          `监控到被观察 trader 仓位存在， 想要处理 changes，但 diff.diff(actionList, lastActionList, this.actionCompare); 结果为空。当前参数为：
          lastActionList: ${JSON.stringify(lastActionList)}
          actionList: ${JSON.stringify(actionList)}
          changes: ${JSON.stringify(changes)}
          `,
        );
        return;
      }

      const event: TradeEvent = {
        trade: bnTrade,
        updateAction: action,
        raw: trade,
      };

      this.logger.log('发出 POSITION_UPDATED 事件');
      this.eventEmitter.emit(POSITION_UPDATED, event);

      const index = this.bnTradeList.indexOf(bnTrade);
      this.bnTradeList[index].actions = actionList;
      this.logger.debug(`bnTradeList: ${JSON.stringify(this.bnTradeList)}`);
    }
  }

  private actionCompare(x: IPositionIncrease | IPositionDecrease, y: IPositionIncrease | IPositionDecrease) {
    return x.id === y.id;
  }

  private tradesCompare(x: GMXTrade, y: GMXTrade) {
    return x.indexToken == y.indexToken && x.account == y.account && x.updateList.length == y.updateList.length;
  }

  private notifyClosePosition(trade: ITrade, symbol: string, pair: string) {
    const event: TradeEvent = {
      trade: {
        openTimestamp: trade.timestamp,
        symbol: symbol,
        pair: pair,
        actions: [],
      },
      closeAction: trade.closedPosition,
      raw: trade,
    };

    this.logger.log('发出 POSITION_CLOSED 事件');
    this.eventEmitter.emit(POSITION_CLOSED, event);

    _.remove(this.bnTradeList, { symbol: symbol });
    this.logger.debug(`bnTradeList: ${JSON.stringify(this.bnTradeList)}`);
  }

  stopWatch() {
    this.startWatch = false;
    this._isWatching = false;
    this._lastQueryTrades = [];
    this._watchingInfo = { account: undefined, status: undefined };
  }

  async syncQueryToBNTradeList() {
    if (_.isEmpty(this._lastQueryTrades)) {
      return;
    }

    this._lastQueryTrades?.forEach((trade) => {
      const actionList = getOrderedActionList(trade);
      const symbol = TOKEN_SYMBOL.get(trade.indexToken);
      if (!symbol) {
        return;
      }

      const pair = symbol + 'USDT';

      const newTrade = { symbol: symbol, openTimestamp: trade.timestamp, actions: actionList, pair: pair };
      this.bnTradeList.push(newTrade);
    });

    this.logger.debug(`同步 gmx query 数据完成，bnTradeList: ${JSON.stringify(this.bnTradeList)}`);
  }
}
