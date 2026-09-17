import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { JobsController } from './jobs.controller.js';

@Module({ imports: [AuthModule], controllers: [JobsController] })
export class JobsModule {}
