import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../shared/decorators/public.decorator';

/**
 * Liveness/readiness endpoint for the platform (Knative probes, deploy smoke test).
 * Public and unthrottled: probes arrive every few seconds from a single node IP and
 * must never consume the per-IP request budget of real clients.
 */
@Controller('health')
export class HealthController {
  @Public()
  @SkipThrottle()
  @Get()
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
