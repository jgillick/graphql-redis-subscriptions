import { RedisOptions, Redis as RedisClient, Cluster } from 'ioredis';
import { PubSubEngine } from 'graphql-subscriptions';
import { PubSubAsyncIterator } from './pubsub-async-iterator';

export interface PubSubRedisOptions {
  connection?: RedisOptions;
  triggerTransform?: TriggerTransform;
  connectionListener?: (err: Error) => void;
  publisher?: RedisClient | Cluster;
  subscriber?: RedisClient | Cluster;
  reviver?: Reviver;
  serializer?: Serializer;
  deserializer?: Deserializer;
}

export class RedisPubSub implements PubSubEngine {
  private readonly serializer?: Serializer;
  private readonly deserializer?: Deserializer;

  constructor(options: PubSubRedisOptions = {}) {
    const {
      triggerTransform,
      connection,
      connectionListener,
      subscriber,
      publisher,
      reviver,
      serializer,
      deserializer,
    } = options;

    this.triggerTransform = triggerTransform || (trigger => trigger as string);

    if (reviver && deserializer) {
      throw new Error("Reviver and deserializer can't be used together");
    }

    this.reviver = reviver;
    this.serializer = serializer;
    this.deserializer = deserializer;

    if (subscriber && publisher) {
      this.redisPublisher = publisher;
      this.redisSubscriber = subscriber;
    } else {
      try {
        const IORedis = require('ioredis');
        this.redisPublisher = new IORedis(connection);
        this.redisSubscriber = new IORedis(connection);

        if (connectionListener) {
          this.redisPublisher.on('connect', connectionListener);
          this.redisPublisher.on('error', connectionListener);
          this.redisSubscriber.on('connect', connectionListener);
          this.redisSubscriber.on('error', connectionListener);
        } else {
          this.redisPublisher.on('error', console.error);
          this.redisSubscriber.on('error', console.error);
        }
      } catch (error) {
        console.error(
          `No publisher or subscriber instances were provided and the package 'ioredis' wasn't found. Couldn't create Redis clients.`,
        );
      }
    }

    // handle messages received via psubscribe and subscribe
    this.redisSubscriber.on('pmessage', this.onMessage.bind(this));
    // partially applied function passes undefined for pattern arg since 'message' event won't provide it:
    this.redisSubscriber.on('message', this.onMessage.bind(this, undefined));

    this.subscriptionMap = {};
    this.subsRefsMap = {};
    this.currentSubscriptionId = 0;
  }

  public async publish<T>(trigger: string, payload: T): Promise<void> {
    await this.redisPublisher.publish(trigger, this.serializer ? this.serializer(payload) : JSON.stringify(payload));
  }

  public subscribe(
    trigger: string,
    onMessage: Function,
    options: Object = {},
  ): Promise<number> {

    const triggerName: string = this.triggerTransform(trigger, options);
    const id = this.currentSubscriptionId++;
    this.subscriptionMap[id] = [triggerName, onMessage];

    const refs = this.subsRefsMap[triggerName];
    if (refs && refs.length > 0) {
      const newRefs = [...refs, id];
      this.subsRefsMap[triggerName] = newRefs;
      return Promise.resolve(id);
    } else {
      return new Promise<number>((resolve, reject) => {
        const subscribeFn = !!options['pattern'] ? this.redisSubscriber.psubscribe : this.redisSubscriber.subscribe;

        subscribeFn.call(this.redisSubscriber, triggerName, err => {
          if (err) {
            reject(err);
          } else {
            this.subsRefsMap[triggerName] = [
              ...(this.subsRefsMap[triggerName] || []),
              id,
            ];
            resolve(id);
          }
        });
      });
    }
  }

  public unsubscribe(subId: number) {
    const [triggerName = null] = this.subscriptionMap[subId] || [];
    const refs = this.subsRefsMap[triggerName];

    if (!refs) throw new Error(`There is no subscription of id "${subId}"`);

    if (refs.length === 1) {
      // unsubscribe from specific channel and pattern match
      this.redisSubscriber.unsubscribe(triggerName);
      this.redisSubscriber.punsubscribe(triggerName);

      delete this.subsRefsMap[triggerName];
    } else {
      const index = refs.indexOf(subId);
      const newRefs =
        index === -1
          ? refs
          : [...refs.slice(0, index), ...refs.slice(index + 1)];
      this.subsRefsMap[triggerName] = newRefs;
    }
    delete this.subscriptionMap[subId];
  }

  public asyncIterator<T>(triggers: string | string[], options?: Object): AsyncIterator<T> {
    return new PubSubAsyncIterator<T>(this, triggers, options);
  }

  public getSubscriber(): RedisClient {
    return this.redisSubscriber;
  }

  public getPublisher(): RedisClient {
    return this.redisPublisher;
  }

  public close(): Promise<any> {
    return Promise.all([
      this.redisPublisher.quit(),
      this.redisSubscriber.quit(),
    ]);
  }

  private onMessage(pattern: string, channel: string, message: string) {
    const subscribers = this.subsRefsMap[pattern || channel];

    // Don't work for nothing..
    if (!subscribers || !subscribers.length) return;

    let parsedMessage;
    try {
      parsedMessage = this.deserializer ? this.deserializer(message) : JSON.parse(message, this.reviver);
    } catch (e) {
      parsedMessage = message;
    }

    for (const subId of subscribers) {
      const [, listener] = this.subscriptionMap[subId];
      listener(parsedMessage);
    }
  }

  private triggerTransform: TriggerTransform;
  private redisSubscriber: RedisClient;
  private redisPublisher: RedisClient;
  private reviver: Reviver;

  private subscriptionMap: { [subId: number]: [string, Function] };
  private subsRefsMap: { [trigger: string]: Array<number> };
  private currentSubscriptionId: number;
}

export type Path = Array<string | number>;
export type Trigger = string | Path;
export type TriggerTransform = (
  trigger: Trigger,
  channelOptions?: Object,
) => string;
export type Reviver = (key: any, value: any) => any;
export type Serializer = (source: any) => string;
export type Deserializer = (source: string) => any;
