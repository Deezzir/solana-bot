import { Commitment, ParsedTransactionWithMeta, PublicKey } from '@solana/web3.js';
import * as common from './common';
import { WS_URL } from '../constants';
import { deserialize_parsed_transaction, type RawParsedTransaction } from './trade_common';

export interface Subscriber {
    type: SubscriberType;
    subscribe(on_logs: (data: any) => void): Promise<void>;
    unsubscribe(): Promise<void>;
}

interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: number;
    result?: number | boolean;
    error?: { code: number; message: string };
}

interface TransactionSubscribeResult {
    signature: string;
    slot: number;
    transactionIndex?: number;
    transaction: {
        transaction: RawParsedTransaction['transaction'];
        meta: RawParsedTransaction['meta'];
        version?: 'legacy' | 0 | 1;
    };
}

interface TransactionSubscribeNotification {
    jsonrpc: '2.0';
    method: 'transactionNotification';
    params: {
        result: TransactionSubscribeResult;
        subscription: number;
    };
}

export type TransactionSubscribeMessage = JsonRpcResponse | TransactionSubscribeNotification;

export enum SubscriberType {
    Logs = 'logs',
    Tx = 'tx'
}

export function deserialize_transaction_notification(
    message: TransactionSubscribeMessage
): ParsedTransactionWithMeta | null {
    if (!('method' in message) || message.method !== 'transactionNotification') return null;

    const result = message.params.result;
    return deserialize_parsed_transaction({ ...result.transaction, slot: result.slot });
}

export class LogsSubscriber implements Subscriber {
    type: SubscriberType = SubscriberType.Logs;
    private sub_id: number | null = null;
    private commitment: Commitment;
    private address: PublicKey;
    private ready_abort: AbortController | null = null;

    constructor(address: PublicKey, commitment: Commitment) {
        this.address = address;
        this.commitment = commitment;
    }

    async subscribe(on_logs: (logs: string[], signature?: string) => void): Promise<void> {
        const ready_abort = new AbortController();
        this.ready_abort = ready_abort;
        this.sub_id = global.CONNECTION.onLogs(
            this.address,
            async ({ err, logs, signature }) => {
                if (err) return;
                if (logs) on_logs(logs, signature);
            },
            this.commitment
        );
        if (this.sub_id === undefined) throw new Error('Failed to subscribe to logs');
        try {
            await global.CONNECTION.awaitSubscriptionReady(this.sub_id, { abortSignal: ready_abort.signal });
        } finally {
            if (this.ready_abort === ready_abort) this.ready_abort = null;
        }
    }

    async unsubscribe(): Promise<void> {
        this.ready_abort?.abort();
        this.ready_abort = null;
        const sub_id = this.sub_id;
        this.sub_id = null;
        if (sub_id !== null) await global.CONNECTION.removeOnLogsListener(sub_id);
    }
}

export class TxSubscriber implements Subscriber {
    type: SubscriberType = SubscriberType.Tx;
    private commitment: Commitment;
    private address: PublicKey;
    private ws: WebSocket | null = null;
    private ping_interval: NodeJS.Timeout | null = null;
    private ping_interval_ms: number = 30000;
    private reconnecting: boolean = false;
    private reconnect_attempts: number = 0;
    private reconnect_timeout: ReturnType<typeof setTimeout> | null = null;
    private subscription_id: number | null = null;
    private stopped: boolean = true;
    private pending_ready: { resolve: () => void; reject: (error: Error) => void } | null = null;

    static readonly PingID = 421;
    static readonly SubscribeID = 420;
    static readonly SubscribeMethod = 'transactionSubscribe';

    constructor(address: PublicKey, commitment: Commitment) {
        this.address = address;
        this.commitment = commitment;
        this.ws = null;
    }

    private start_ping() {
        this.ping_interval = setInterval(() => {
            if (this.ws && this.ws.readyState !== WebSocket.OPEN) return;
            if (!this.ws) return;

            this.ws.send(
                JSON.stringify({
                    jsonrpc: '2.0',
                    id: TxSubscriber.PingID,
                    method: 'ping'
                })
            );
        }, this.ping_interval_ms);
    }

    private reconnect(on_logs: (message: TransactionSubscribeMessage) => void) {
        if (this.stopped || this.reconnecting) return;
        this.reconnecting = true;

        if (this.ping_interval) {
            clearInterval(this.ping_interval);
            this.ping_interval = null;
        }

        if (this.ws) {
            this.ws.onclose = null;
            this.ws.onerror = null;
            this.ws.close();
            this.ws = null;
        }

        const delay = common.compute_backoff_delay(this.reconnect_attempts, {
            initial_delay_ms: 1000,
            backoff_multiplier: 2,
            max_delay_ms: 30000
        });
        this.reconnect_attempts++;
        this.reconnect_timeout = setTimeout(() => {
            this.reconnect_timeout = null;
            if (this.stopped) return;
            this.reconnecting = false;
            this.subscribe(on_logs).catch((err) => {
                common.error(common.red(`Failed to reconnect to WebSocket: ${err}`));
                if (!this.stopped) this.reconnect(on_logs);
            });
        }, delay);
    }

    private prepare_request(
        encoding: 'jsonParsed' | 'base64' = 'jsonParsed',
        show_rewards: boolean = false,
        details: 'full' | 'signatures' = 'full'
    ) {
        return {
            jsonrpc: '2.0',
            id: TxSubscriber.SubscribeID,
            method: TxSubscriber.SubscribeMethod,
            params: [
                {
                    accountInclude: [this.address.toBase58()]
                },
                {
                    commitment: String(this.commitment),
                    encoding: encoding,
                    transactionDetails: details,
                    showRewards: show_rewards,
                    maxSupportedTransactionVersion: 1
                }
            ]
        };
    }

    async subscribe(on_logs: (message: TransactionSubscribeMessage) => void): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this.pending_ready = { resolve, reject };
            this.stopped = false;
            this.subscription_id = null;
            this.ws = new WebSocket(WS_URL);

            this.ws.onopen = () => {
                try {
                    this.start_ping();
                    const request = this.prepare_request();
                    this.ws!.send(JSON.stringify(request));
                } catch (error) {
                    this.reject_ready(error instanceof Error ? error : new Error(String(error)));
                    common.error(common.red(`Failed to send WebSocket subscription: ${error}`));
                }
            };

            this.ws.onmessage = (event: MessageEvent) => {
                const raw = typeof event.data === 'string' ? event.data : event.data.toString();
                try {
                    const message: TransactionSubscribeMessage = JSON.parse(raw);
                    if ('id' in message && message.id === TxSubscriber.PingID) return;
                    if ('id' in message && message.id === TxSubscriber.SubscribeID) {
                        if (message.error) throw new Error(`Transaction subscription failed: ${message.error.message}`);
                        if (typeof message.result !== 'number')
                            throw new Error('Invalid transaction subscription response.');
                        this.subscription_id = message.result;
                        this.reconnect_attempts = 0;
                        this.pending_ready?.resolve();
                        this.pending_ready = null;
                        return;
                    }
                    if (!('method' in message) || message.params.subscription !== this.subscription_id) return;
                    on_logs(message);
                } catch (error) {
                    this.reject_ready(error instanceof Error ? error : new Error(String(error)));
                    common.error(common.red(`Failed to process WebSocket message: ${error}`));
                    return;
                }
            };

            this.ws.onerror = (event: Event) => {
                const error = new Error(`WebSocket error: ${event instanceof ErrorEvent ? event.message : event.type}`);
                this.reject_ready(error);
                common.error(common.red(error.message));
                if (!this.stopped && this.ws && this.ws.readyState !== WebSocket.OPEN) this.reconnect(on_logs);
            };

            this.ws.onclose = (event: CloseEvent) => {
                if (this.stopped) return;
                const reason = event.reason || 'unknown';
                this.reject_ready(new Error(`WebSocket closed before subscription activation: ${reason}`));
                common.warn(`WebSocket closed. Code: ${event.code}, Reason: ${reason}. Attempting to reconnect...`);
                if (this.ping_interval) clearInterval(this.ping_interval);
                this.reconnect(on_logs);
            };
        });
    }

    private reject_ready(error: Error): void {
        this.pending_ready?.reject(error);
        this.pending_ready = null;
    }

    async unsubscribe(): Promise<void> {
        this.stopped = true;
        this.reject_ready(new Error('Transaction subscription cancelled before activation.'));
        this.subscription_id = null;
        if (this.ping_interval) clearInterval(this.ping_interval);
        if (this.reconnect_timeout) clearTimeout(this.reconnect_timeout);
        this.reconnect_timeout = null;
        if (this.ws && this.ws.readyState < WebSocket.CLOSING) this.ws.close();
        this.ws = null;
        this.reconnecting = false;
        this.reconnect_attempts = 0;
    }
}
