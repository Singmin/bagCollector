import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AdminModule } from './admin/admin.module.js';
import { AssetsModule } from './assets/assets.module.js';
import { AuthModule } from './auth/auth.module.js';
import { CollectiblesModule } from './collectibles/collectibles.module.js';
import { env } from './common/env.js';
import { QueueModule } from './common/queue.module.js';
import { DatabaseModule } from './database/database.module.js';
import { FeedModule } from './feed/feed.module.js';
import { HealthController } from './health.controller.js';
import { JobsModule } from './jobs/jobs.module.js';
import { OfficialBagsModule } from './official-bags/official-bags.module.js';
import { ShelvesModule } from './shelves/shelves.module.js';
import { SubmissionsModule } from './submissions/submissions.module.js';
import { UploadsModule } from './uploads/uploads.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    DatabaseModule,
    QueueModule,
    JwtModule.register({ global: true, secret: env().JWT_SECRET }),
    AuthModule,
    AssetsModule,
    ShelvesModule,
    CollectiblesModule,
    UploadsModule,
    JobsModule,
    AdminModule,
    OfficialBagsModule,
    SubmissionsModule,
    FeedModule,
    UsersModule
  ],
  controllers: [HealthController]
})
export class AppModule {}
