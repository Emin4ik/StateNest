import { Command } from 'commander';
import { openContext } from '../context.js';
import { heading, print, style } from '../output.js';
import { startDashboard, isLoopbackHost } from '../../dashboard/server.js';
import { contractHome } from '../../util/paths.js';

export function dashboardCommand(): Command {
  return new Command('dashboard')
    .description('Browse your projects, machines and servers in a local web page')
    .option('-p, --port <port>', 'port to serve on', (value) => Number.parseInt(value, 10))
    .option('--host <host>', 'address to bind to (loopback only unless forced)')
    .option(
      '--yes-expose-me',
      'allow binding to a non-loopback address, exposing your project list to the network',
    )
    .option('--open', 'open the dashboard in your browser')
    .action(async (options: DashboardCliOptions) => {
      const { workspace } = await openContext();

      const running = await startDashboard(workspace, {
        ...(options.host ? { host: options.host } : {}),
        ...(options.port ? { port: options.port } : {}),
        ...(options.yesExposeMe ? { allowNonLoopback: true } : {}),
      });

      print('');
      heading('Project Brain dashboard');
      print('');
      print(`  ${style.cyan(running.url)}`);
      print(`  ${style.dim(`profile: ${workspace.profile.name}  ·  ${contractHome(workspace.paths.home)}`)}`);
      print('');

      const host = options.host ?? workspace.config.dashboard.host;
      if (!isLoopbackHost(host)) {
        print(
          style.yellow(
            '  Serving on a non-loopback address. Anything on your network can read\n' +
              '  your project list, machine names and server addresses.',
          ),
        );
        print('');
      }

      print(style.dim('  Read-only. Press Ctrl+C to stop.'));
      print('');

      if (options.open) await openInBrowser(running.url);

      // Hold the process open until interrupted, then shut down cleanly so the
      // port is released immediately rather than lingering in TIME_WAIT.
      await new Promise<void>((resolve) => {
        const stop = () => {
          void running.close().then(() => {
            print(style.dim('Dashboard stopped.'));
            resolve();
          });
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
    });
}

interface DashboardCliOptions {
  port?: number;
  host?: string;
  yesExposeMe?: boolean;
  open?: boolean;
}

/**
 * Open a URL in the user's browser.
 *
 * The URL is passed as an argument array, never through a shell, so a port or
 * host cannot become a command.
 */
async function openInBrowser(url: string): Promise<void> {
  const { spawn } = await import('node:child_process');
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  try {
    spawn(command, [url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    // Not being able to open a browser is not worth failing the command over;
    // the URL is already printed.
  }
}
