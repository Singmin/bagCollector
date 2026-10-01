import 'reflect-metadata';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { env } from './common/env.js';

async function bootstrap() {
  const config = env();
  const adapter = new FastifyAdapter({
    logger: config.NODE_ENV !== 'test',
    bodyLimit: 1_048_576,
    trustProxy: true
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter);

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' }
  });
  await app.register(multipart, {
    limits: { files: 1, fileSize: config.MAX_UPLOAD_BYTES }
  });

  // Fastify 默认要求声明了 application/json 的请求必须带 body，否则直接 400
  // （DELETE 这类无 body 的请求最常踩到）。这里把空 body 解析成 undefined，
  // 非空 body 仍按 JSON 解析，非法 JSON 返回 400。
  // 必须通过 adapter.useBodyParser 注册：它会标记 _isParserRegistered，
  // 避免 Nest 在 init 时再注册默认 JSON parser 导致 FST_ERR_CTP_ALREADY_PRESENT。
  // useBodyParser 强制 parseAs: 'buffer'，因此 parser 收到的是 Buffer。
  adapter.useBodyParser('application/json', false, {}, (_request, body, done) => {
    const raw = Buffer.isBuffer(body) ? body.toString('utf8').trim() : '';
    if (!raw) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(raw));
    } catch {
      const error = new Error('请求体不是合法的 JSON') as Error & { statusCode?: number };
      error.statusCode = 400;
      done(error, undefined);
    }
  });

  app.setGlobalPrefix('api');
  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('BagCollect API')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, swaggerConfig));

  await app.listen({ port: config.API_PORT, host: '0.0.0.0' });
  Logger.log(`BagCollect API listening on ${config.API_PORT}`);
}

void bootstrap();
