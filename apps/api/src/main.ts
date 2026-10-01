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
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({
    logger: config.NODE_ENV !== 'test',
    bodyLimit: 1_048_576,
    trustProxy: true
  }));

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
  app
    .getHttpAdapter()
    .getInstance()
    .addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
      const raw = typeof body === 'string' ? body.trim() : '';
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
