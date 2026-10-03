import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { VersioningType } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import helmet from 'helmet';
import { createServer, Server } from 'node:http';
import { AppModule } from './app.module';
import { AppConfig, loadConfig } from './config/config';
import { runMigrations } from './database/migrate';
import { MetricsService } from './observability/metrics.service';

export async function createApp(config: AppConfig): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
    bufferLogs: true,
    bodyParser: false,
  });
  app.useLogger(app.get(Logger));
  app.useBodyParser('json', { limit: '100kb' });
  app.use(helmet());
  app.disable('x-powered-by');
  app.enableVersioning({ type: VersioningType.URI });
  app.enableShutdownHooks();

  const doc = new DocumentBuilder()
    .setTitle('Program Capacity Service')
    .setDescription('Financing program capacity and invoice reservations. All amounts are decimal strings.')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, cleanupOpenApiDoc(SwaggerModule.createDocument(app, doc)));
  return app;
}

/** Prometheus metrics on a separate, internal-only port (not exposed through the public ingress). */
function startMetricsServer(metrics: MetricsService, port: number): Server {
  return createServer((req, res) => {
    if (req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    metrics.registry
      .metrics()
      .then((body) => res.writeHead(200, { 'Content-Type': metrics.registry.contentType }).end(body))
      .catch(() => res.writeHead(500).end());
  }).listen(port);
}

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  if (config.RUN_MIGRATIONS) await runMigrations(config.DATABASE_URL, (m) => console.log(m));

  const app = await createApp(config);
  const metricsServer = startMetricsServer(app.get(MetricsService), config.METRICS_PORT);
  app.get(Logger).log(`Metrics on :${config.METRICS_PORT}/metrics`);
  process.once('SIGTERM', () => metricsServer.close());

  await app.listen(config.PORT);
  app.get(Logger).log(`Listening on :${config.PORT} (docs at /docs)`);
}

if (require.main === module) {
  bootstrap().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
