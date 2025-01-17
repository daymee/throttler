import { CanActivate, ExecutionContext, Inject, Injectable, ContextType } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { optionalRequire } from '@nestjs/core/helpers/optional-require';
import * as md5 from 'md5';
import { ThrottlerModuleOptions } from './throttler-module-options.interface';
import { ThrottlerStorage } from './throttler-storage.interface';
import {
  THROTTLER_LIMIT,
  THROTTLER_OPTIONS,
  THROTTLER_SKIP,
  THROTTLER_TTL,
} from './throttler.constants';
import { ThrottlerException } from './throttler.exception';

/**
 * @publicApi
 */
@Injectable()
export class ThrottlerGuard implements CanActivate {
  constructor(
    @Inject(THROTTLER_OPTIONS) private readonly options: ThrottlerModuleOptions,
    @Inject(ThrottlerStorage) private readonly storageService: ThrottlerStorage,
    private readonly reflector: Reflector,
  ) {}

  /**
   * Throttle requests against their TTL limit and whether to allow or deny it.
   * Based on the context type different handlers will be called.
   * @throws ThrottlerException
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const classRef = context.getClass();

    // Return early if the current route should be skipped.
    if (this.reflector.getAllAndOverride<boolean>(THROTTLER_SKIP, [handler, classRef])) {
      return true;
    }

    // Return early when we have no limit or ttl data.
    const routeOrClassLimit = this.reflector.getAllAndOverride<number>(THROTTLER_LIMIT, [
      handler,
      classRef,
    ]);
    const routeOrClassTtl = this.reflector.getAllAndOverride<number>(THROTTLER_TTL, [
      handler,
      classRef,
    ]);

    // Check if specific limits are set at class or route level, otherwise use global options.
    const limit = routeOrClassLimit || this.options.limit;
    const ttl = routeOrClassTtl || this.options.ttl;

    switch (context.getType<ContextType | 'graphql'>()) {
      case 'http':
        return this.httpHandler(context, limit, ttl);
      case 'ws':
        return this.websocketHandler(context, limit, ttl);
      case 'graphql':
        return this.graphqlHandler(context, limit, ttl);
      default:
        return true;
    }
  }

  /**
   * Throttles incoming HTTP requests.
   * All the outgoing requests will contain RFC-compatible RateLimit headers.
   * @see https://tools.ietf.org/id/draft-polli-ratelimit-headers-00.html#header-specifications
   * @throws ThrottlerException
   */
  private async httpHandler(
    context: ExecutionContext,
    limit: number,
    ttl: number,
  ): Promise<boolean> {
    const headerPrefix = 'X-RateLimit';
    // Here we start to check the amount of requests being done against the ttl.
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();

    // Return early if the current user agent should be ignored.
    if (Array.isArray(this.options.ignoreUserAgents)) {
      for (const pattern of this.options.ignoreUserAgents) {
        if (pattern.test(req.headers['user-agent'])) {
          return true;
        }
      }
    }

    const ip = this.options.extractIPFromHeaders
      ? this.options.extractIPFromHeaders(req.headers)
      : req.ip;
    const key = this.generateKey(context, ip);
    const ttls = await this.storageService.getRecord(key);
    const nearestExpiryTime = ttls.length > 0 ? Math.ceil((ttls[0] - Date.now()) / 1000) : 0;

    // Throw an error when the user reached their limit.
    if (ttls.length >= limit) {
      res.header('Retry-After', nearestExpiryTime);
      throw new ThrottlerException();
    }

    res.header(`${headerPrefix}-Limit`, limit);
    // We're about to add a record so we need to take that into account here.
    // Otherwise the header says we have a request left when there are none.
    res.header(`${headerPrefix}-Remaining`, Math.max(0, limit - (ttls.length + 1)));
    res.header(`${headerPrefix}-Reset`, nearestExpiryTime);

    await this.storageService.addRecord(key, ttl);
    return true;
  }

  /**
   * Throttles websocket requests.
   * Both socket.io and websockets are supported.
   * @throws ThrottlerException
   */
  private async websocketHandler(
    context: ExecutionContext,
    limit: number,
    ttl: number,
  ): Promise<boolean> {
    const { ThrottlerWsException } = optionalRequire('./throttler-ws.exception', () =>
      require('./throttler-ws.exception'),
    );
    const client = context.switchToWs().getClient();
    const ip = this.options.extractIPFromHeaders
      ? this.options.extractIPFromHeaders(client.handshake.headers)
      : ['conn', '_socket']
          .map((key) => client[key])
          .filter((obj) => obj)
          .shift().remoteAddress;
    const key = this.generateKey(context, ip);
    const ttls = await this.storageService.getRecord(key);

    if (ttls.length >= limit) {
      if (ThrottlerWsException) {
        throw new ThrottlerWsException();
      } else {
        throw new ThrottlerException();
      }
    }

    await this.storageService.addRecord(key, ttl);
    return true;
  }

  private async graphqlHandler(
    context: ExecutionContext,
    limit: number,
    ttl: number,
  ): Promise<boolean> {
    const { req, res } = context.getArgByIndex(2);
    // Return early for GQL Fastify or if the res doesn't exist.
    if (!res) {
      return true;
    }
    const httpContext: ExecutionContext = {
      ...context,
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => res,
        getNext: context.switchToHttp().getNext,
      }),
      getClass: context.getClass,
      getHandler: context.getHandler,
    };
    return this.httpHandler(httpContext, limit, ttl);
  }

  /**
   * Generate a hashed key that will be used as a storage key.
   * The key will always be a combination of the current context and IP.
   */
  private generateKey(context: ExecutionContext, suffix: string): string {
    const prefix = `${context.getClass().name}-${context.getHandler().name}`;
    return md5(`${prefix}-${suffix}`);
  }
}
