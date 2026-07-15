import { Context } from 'koa';
import crypto from 'crypto';
import { config } from '../config';
import { success, fail } from '../utils/response';

export class AuthController {
  async login(ctx: Context) {
    const { username = '', password } = ctx.request.body as any;
    if (!config.accessPassword) {
      return success(ctx, { token: '', required: false });
    }
    if ((config.accessUsername && username !== config.accessUsername) || password !== config.accessPassword) {
      return fail(ctx, 'Invalid username or password', 401);
    }
    const credential = config.accessUsername ? `${config.accessUsername}:${config.accessPassword}` : config.accessPassword;
    const token = crypto.createHash('sha256').update(credential).digest('hex');
    success(ctx, { token, required: true });
  }

  async check(ctx: Context) {
    success(ctx, { required: !!config.accessPassword, usernameRequired: !!config.accessUsername });
  }
}
