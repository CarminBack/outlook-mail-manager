import Router from 'koa-router';
import { OAuthImportController } from '../controllers/OAuthImportController';

export const oauthImportRoutes = new Router();
const ctrl = new OAuthImportController();

oauthImportRoutes.post('/start', ctx => ctrl.start(ctx));
oauthImportRoutes.post('/status', ctx => ctrl.status(ctx));
