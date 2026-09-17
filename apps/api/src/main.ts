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
