// Must load before any other local import: AppModule's own import graph
// (AuthModule -> ... -> shared/config/jwt.constants.ts) reads process.env at
// *module-import* time to fail fast on a missing JWT_ACCESS_SECRET, which
// happens before ConfigModule.forRoot()'s dotenv loading would otherwise run.
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // SPA_DIR is set only in the production image, where the API also serves the
  // built frontend from the same origin.
  configureApp(app, { spaDir: process.env.SPA_DIR });
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
