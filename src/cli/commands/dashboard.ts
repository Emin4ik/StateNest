import { Command } from 'commander';
import { openContext } from '../context.js';
import { heading, print, style } from '../output.js';
import { startDashboard, isLoopbackHost, type ProfileView } from '../../dashboard/server.js';
import { Registry } from '../../core/registry.js';
import { Workspace, listProfileNames } from '../../core/workspace.js';
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
    .option(
      '--all-profiles',
      'show every profile in one read-only view, each row labelled with its profile',
    )
    .action(async (options: DashboardCliOptions) => {
      const { workspace } = await openContext();

      // Profiles stay separate on disk and in sync. This is a read-only join
      // for display only: each view opens its own workspace, and the dashboard
      // has no endpoint that writes anything, so a unified view cannot write
      // to the wrong profile.
      const views: ProfileView[] = [
        { name: workspace.profile.name, workspace, registry: new Registry(workspace.store) },
      ];

      if (options.allProfiles) {
        for (const name of await listProfileNames(workspace.paths)) {
          if (name === workspace.profile.name) continue;
          const other = await Workspace.open({ home: workspace.paths.home, profile: name });
          views.push({ name, workspace: other, registry: new Registry(other.store) });
        }
        views.sort((a, b) => a.name.localeCompare(b.name));
      }

      const running = await startDashboard(views, {
        ...(options.host ? { host: options.host } : {}),
        ...(options.port ? { port: options.port } : {}),
        ...(options.yesExposeMe ? { allowNonLoopback: true } : {}),
      });

      print('');
      heading('StateNest dashboard');
      print('');
      print(`  ${style.cyan(running.url)}`);
      const shown =
        views.length === 1 ? workspace.profile.name : `${views.map((v) => v.name).join(', ')} (read-only)`;
      print(`  ${style.dim(`profile: ${shown}  ·  ${contractHome(workspace.paths.home)}`)}`);
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
  allProfiles?: boolean;
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
