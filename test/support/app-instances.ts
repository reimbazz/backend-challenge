import type { Subprocess } from 'bun';
import { TEST_DATABASE_NAME } from './test-database';

export interface RunningInstance {
  baseUrl: string;
  process: Subprocess;
}

/**
 * Sobe N processos reais da aplicação (bun run src/main.ts), cada um com seu pool de conexões,
 * apontando para o mesmo banco de testes.
 */
export async function startInstances(count: number, firstPort: number, extraEnv: Record<string, string> = {}): Promise<RunningInstance[]> {
  const instances = Array.from({ length: count }, (_, index) => {
    const port = firstPort + index;
    const childProcess = Bun.spawn(['bun', 'run', 'src/main.ts'], {
      env: {
        ...process.env,
        HTTP_PORT: String(port),
        INSTANCE_NAME: `test-instance-${index + 1}`,
        DATABASE_NAME: TEST_DATABASE_NAME,
        WORKERS_ENABLED: 'false',
        LOG_LEVEL: 'warn',
        ...extraEnv,
      },
      stdout: 'ignore',
      stderr: 'inherit',
    });
    return { baseUrl: `http://localhost:${port}`, process: childProcess };
  });

  await Promise.all(instances.map((instance) => waitUntilLive(instance.baseUrl)));
  return instances;
}

export async function stopInstances(instances: RunningInstance[]): Promise<void> {
  for (const instance of instances) {
    instance.process.kill('SIGTERM');
  }
  await Promise.all(instances.map((instance) => instance.process.exited));
}

async function waitUntilLive(baseUrl: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health/live`);
      if (response.ok) return;
    } catch {
      // ainda subindo
    }
    await Bun.sleep(200);
  }
  throw new Error(`instância ${baseUrl} não ficou pronta em ${timeoutMs}ms`);
}

export async function postJson(url: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}
