import net from 'node:net';

export class PortManager {
  private static usedPorts: Set<number> = new Set();

  static async allocatePort(preferred?: number): Promise<number> {
    const tryPort = (port: number): Promise<number> => {
      return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
            resolve(0);
          } else {
            reject(err);
          }
        });
        server.listen(port, '127.0.0.1', () => {
          const address = server.address();
          if (address && typeof address === 'object') {
            PortManager.usedPorts.add(address.port);
          }
          server.close(() => {
            resolve(port);
          });
        });
      });
    };

    if (preferred !== undefined && !PortManager.usedPorts.has(preferred)) {
      const result = await tryPort(preferred);
      if (result !== 0) return result;
    }

    for (let i = 0; i < 100; i++) {
      const candidate = 9000 + Math.floor(Math.random() * 60000);
      if (PortManager.usedPorts.has(candidate)) continue;
      const result = await tryPort(candidate);
      if (result !== 0) return result;
    }

    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address && typeof address === 'object') {
          PortManager.usedPorts.add(address.port);
          server.close(() => resolve(address.port));
        } else {
          reject(new Error('Failed to get port from OS'));
        }
      });
      server.on('error', reject);
    });
  }
}
