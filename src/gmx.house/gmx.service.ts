import { Injectable } from '@nestjs/common';

import { EventEmitter2 } from '@nestjs/event-emitter';
import * as _ from 'lodash';
import { POSITION_CLOSED, POSITION_INCREASE } from 'src/common/constants';
import { TradeEvent } from 'src/interfaces/gmx.interface';
import * as diff from 'fast-array-diff';
import winston from 'winston';
import { createWinstonLogger } from 'src/common/winston-config.service';
import { TradeAction } from './types';
import { GMXContractService } from './gmx-contract.service';

@Injectable()
export class GMXService {
  private logger: winston.Logger;

  private dealTradeList: TradeAction[] = [];
  private _isWatching = false;

  private _lastQueryTrades: TradeAction[] | undefined;

  private startWatch = false;

  private _watchingInfo: {
    account: string;
  } = {
    account: '0x7B7736a2C07C4332FfaD45a039d2117aE15e3f66',
  };

  constructor(private eventEmitter: EventEmitter2, private contract: GMXContractService) {
    this.logger = createWinstonLogger({ service: GMXService.name });
  }

  async getActivePositions() {
    if (this.contract.positions === undefined) {
      return (await this.contract.getAccountPosition('0x7B7736a2C07C4332FfaD45a039d2117aE15e3f66')).positions;
    }

    return this.contract.positions;
  }

  get isWatching() {
    return this._isWatching;
  }

  get watchingInfo() {
    return this._watchingInfo;
  }

  private async monitorTradeList(account: string) {
    if (!this.startWatch) {
      return;
    }

    const trades = await this.contract.getInterestedTradeActions();
    const changes = diff.diff(this._lastQueryTrades ?? [], trades, (ia, ib) => ia.id === ib.id);

    if (_.isEmpty(changes.added) == false) {
      const added = changes.added;
      this.logger.info(`发现新的 ${added.length} 个交易：`, { added: added });

      for (let index = 0; index < added.length; index++) {
        const trade = added[index];

        if (this.dealTradeList.includes(trade)) {
          this.logger.warn(`早已成交过此 trade: ${trade} 跳过`);
          continue;
        }

        const deal = await this.contract.dealTradeAction(trade);

        if (deal === undefined) {
          this.logger.warn(`没法处理此 trade: ${trade}`);
          this.dealTradeList.push(trade);
          continue;
        }

        const symbol = deal.symbol;
        const pair = symbol + 'USDT';

        const event: TradeEvent = {
          trade: {
            timestamp: Number(trade.data.timestamp),
            symbol: symbol,
            pair: pair,
          },
          deal: deal,
          raw: trade,
        };

        if (deal.status === 'Increase') {
          // 买入信号

          this.logger.info(`${pair} 发出 POSITION_INCREASE 事件`);
          this.eventEmitter.emit(POSITION_INCREASE, event);
        }

        if (deal.status === 'Decrease') {
          // 减仓信号
        }

        if (deal.status === 'Closed' || deal.status === 'Liquidated') {
          // 平仓/清仓信号
          this.logger.info(`${pair} 发出 POSITION_CLOSED 事件`);
          this.eventEmitter.emit(POSITION_CLOSED, event);
        }

        this.logger.info(`结束处理 ${pair} trade: ${trade}`);
        this.dealTradeList.push(trade);
      }
    }

    this._lastQueryTrades = trades;

    await this.monitorTradeList(account);
  }

  async startMonitor(account: string) {
    if (this.isWatching) {
      return;
    }

    this.startWatch = true;
    this._isWatching = true;
    this._watchingInfo = { account: account };

    return await this.monitorTradeList(account);
  }

  stopMonitor() {
    this.startWatch = false;
    this._isWatching = false;
    this._lastQueryTrades = [];
  }
}
