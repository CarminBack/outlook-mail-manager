import { Context } from 'koa';
import { OAuthImportService } from '../services/OAuthImportService';
import { success, fail } from '../utils/response';

const service = new OAuthImportService();

export class OAuthImportController {
  async start(ctx: Context) {
    const { email } = ctx.request.body as { email?: string };
    if (!email) return fail(ctx, 'email is required', 400);
    success(ctx, await service.start(email));
  }

  async status(ctx: Context) {
    const { session_id } = ctx.request.body as { session_id?: string };
    if (!session_id) return fail(ctx, 'session_id is required', 400);
    success(ctx, await service.poll(session_id));
  }
}
