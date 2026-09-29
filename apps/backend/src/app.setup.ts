import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import { AppExceptionFilter } from './shared/errors/app-exception.filter';
import { ValidationException } from './shared/errors/validation.exception';

export const API_PREFIX = 'api';

export interface AppSetupOptions {
  /**
   * Directory of the built frontend (`apps/frontend/dist`). When set, the API also
   * serves the SPA from the same origin, with a fallback to index.html for client-side
   * routes. Unset in native/Docker dev, where Vite serves the frontend.
   */
  spaDir?: string;
}

/** Everything `main.ts` applies to the app before listening; shared with tests. */
export function configureApp(
  app: NestExpressApplication,
  { spaDir }: AppSetupOptions = {},
): void {
  // Behind nginx → Kourier → activator every hop is on a private network. Trusting only
  // those hops makes req.ip the real client (per-IP throttling) without letting a
  // client spoof X-Forwarded-For from outside.
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  app.setGlobalPrefix(API_PREFIX);
  app.enableCors({ origin: true, credentials: true });
  app.use(cookieParser());
  // LocalDiskStorage writes branding logos/profile photos under
  // process.cwd()/uploads; this is Express static middleware, so it sits
  // outside the Nest routing/guard chain and serves these files publicly —
  // deliberate for this codebase (unguessable UUID filenames), not an oversight.
  app.useStaticAssets(join(process.cwd(), 'uploads'), { prefix: '/uploads' });
  if (spaDir) {
    serveSpa(app, spaDir);
  }
  app.useGlobalFilters(new AppExceptionFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      // Maps class-validator failures to the spec's VALIDATION_ERROR error
      // contract (readable message + field-level details) instead of Nest's
      // default HTTP_EXCEPTION-with-array-message shape.
      exceptionFactory: (errors) => new ValidationException(errors),
    }),
  );
}

function serveSpa(app: NestExpressApplication, spaDir: string): void {
  const indexHtmlPath = join(spaDir, 'index.html');
  if (!existsSync(indexHtmlPath)) {
    throw new Error(`SPA_DIR is set but ${indexHtmlPath} does not exist`);
  }
  // The shell is immutable inside the image, so it is read once instead of per request.
  const indexHtml = readFileSync(indexHtmlPath, 'utf8');
  app.useStaticAssets(spaDir, { index: false });
  // Client-side routes (/login, /admin/users, …) get index.html; the API and uploads
  // keep their own 404s instead of silently turning into the SPA shell.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const isRead = req.method === 'GET' || req.method === 'HEAD';
    const isApi =
      req.path === `/${API_PREFIX}` || req.path.startsWith(`/${API_PREFIX}/`);
    const isUpload =
      req.path === '/uploads' || req.path.startsWith('/uploads/');
    if (!isRead || isApi || isUpload) {
      next();
      return;
    }
    res.type('html').send(indexHtml);
  });
}
