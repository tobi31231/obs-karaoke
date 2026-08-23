using System.Diagnostics;
using System.Net;
using System.Net.Http;
using System.Windows.Forms;

namespace ObsKaraokeLauncher;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new LauncherForm());
    }
}

public sealed class LauncherForm : Form
{
    private const string AppUrl = "http://127.0.0.1:5177/";
    private const string OverlayUrl = "http://127.0.0.1:5177/overlay?v=20260823-mismatch-cancel-1";
    private readonly Label _status = new();
    private readonly Button _openApp = new();
    private readonly Button _copyOverlay = new();
    private readonly Button _installModel = new();
    private readonly Button _stop = new();
    private readonly System.Windows.Forms.Timer _pollTimer = new();
    private readonly NotifyIcon _trayIcon = new();
    private readonly ContextMenuStrip _trayMenu = new();
    private Process? _serverProcess;
    private bool _serverWasReady;
    private bool _controlPageOpened;
    private volatile bool _closing;
    private int _serverFailureCount;

    public LauncherForm()
    {
        Text = "OBS Karaoke MVP";
        Width = 520;
        Height = 280;
        MinimumSize = new Size(480, 260);
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;

        var title = new Label
        {
            Text = "OBS Karaoke MVP",
            Font = new Font(Font.FontFamily, 16, FontStyle.Bold),
            AutoSize = true,
            Location = new Point(20, 18)
        };

        _status.Text = "로컬 서버를 시작하는 중입니다...";
        _status.AutoSize = false;
        _status.Width = 460;
        _status.Height = 48;
        _status.Location = new Point(22, 58);

        _openApp.Text = "조작 화면으로 가기";
        _openApp.Location = new Point(22, 124);
        _openApp.Size = new Size(140, 34);
        _openApp.Enabled = false;
        _openApp.Click += (_, _) => OpenControlPage();

        _copyOverlay.Text = "Overlay 주소 복사";
        _copyOverlay.Location = new Point(176, 124);
        _copyOverlay.Size = new Size(150, 34);
        _copyOverlay.Click += (_, _) =>
        {
            Clipboard.SetText(OverlayUrl);
            _status.Text = "OBS Browser Source 주소를 복사했습니다.";
        };

        _installModel.Text = "Turbo 모델 설치";
        _installModel.Location = new Point(340, 124);
        _installModel.Size = new Size(140, 34);
        _installModel.Click += (_, _) => RunBatch("install-turbo-model.bat");

        var overlay = new TextBox
        {
            Text = OverlayUrl,
            ReadOnly = true,
            Location = new Point(22, 176),
            Width = 458
        };

        _stop.Text = "종료";
        _stop.Location = new Point(380, 206);
        _stop.Size = new Size(100, 30);
        _stop.Click += (_, _) => Close();

        Controls.AddRange([title, _status, _openApp, _copyOverlay, _installModel, overlay, _stop]);

        var trayOpen = new ToolStripMenuItem("조작 화면 열기");
        trayOpen.Click += (_, _) => OpenControlPage();
        var trayShow = new ToolStripMenuItem("런처 표시");
        trayShow.Click += (_, _) => ShowLauncher();
        var trayExit = new ToolStripMenuItem("완전 종료");
        trayExit.Click += (_, _) => Close();
        _trayMenu.Items.AddRange([trayOpen, trayShow, new ToolStripSeparator(), trayExit]);
        _trayIcon.Icon = SystemIcons.Application;
        _trayIcon.Text = "OBS Karaoke MVP";
        _trayIcon.ContextMenuStrip = _trayMenu;
        _trayIcon.DoubleClick += (_, _) => OpenControlPage();

        _pollTimer.Interval = 700;
        _pollTimer.Tick += async (_, _) => await PollServerAsync();
        Shown += async (_, _) =>
        {
            StartServer();
            _pollTimer.Start();
            await PollServerAsync();
        };
        FormClosing += (_, _) =>
        {
            _closing = true;
            _trayIcon.Visible = false;
            _trayIcon.Dispose();
            _trayMenu.Dispose();
            StopServer();
        };
    }

    private static string AppDirectory => AppContext.BaseDirectory;

    private bool OpenControlPage()
    {
        if (!IsPortOpen())
        {
            _status.Text = "로컬 서버가 아직 준비되지 않았습니다.";
            return false;
        }

        try
        {
            OpenUrl(AppUrl);
            HideLauncher();
            return true;
        }
        catch (Exception error)
        {
            _status.Text = $"브라우저를 열지 못했습니다: {error.Message}";
            return false;
        }
    }

    private void HideLauncher()
    {
        _trayIcon.Visible = true;
        ShowInTaskbar = false;
        Hide();
    }

    private void ShowLauncher()
    {
        ShowInTaskbar = true;
        Show();
        WindowState = FormWindowState.Normal;
        Activate();
        _trayIcon.Visible = false;
    }

    private static void OpenUrl(string url)
    {
        Process.Start(new ProcessStartInfo
        {
            FileName = url,
            UseShellExecute = true
        });
    }

    private void RunBatch(string fileName)
    {
        var path = Path.Combine(AppDirectory, fileName);
        if (!File.Exists(path))
        {
            MessageBox.Show($"{fileName} 파일을 찾을 수 없습니다.", Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        Process.Start(new ProcessStartInfo
        {
            FileName = path,
            WorkingDirectory = AppDirectory,
            UseShellExecute = true
        });
    }

    private void StartServer()
    {
        if (IsPortOpen())
        {
            _status.Text = "이미 실행 중인 로컬 서버를 사용합니다.";
            return;
        }

        var serverPath = Path.Combine(AppDirectory, "server.js");
        if (!File.Exists(serverPath))
        {
            _status.Text = "server.js 파일을 찾을 수 없습니다. 앱 폴더 구성을 확인하세요.";
            return;
        }

        var node = FindNode();
        if (node is null)
        {
            _status.Text = "Node.js를 찾을 수 없습니다. Node.js 18 이상을 설치하거나 앱 폴더에 node.exe를 넣어주세요.";
            return;
        }

        _serverProcess = Process.Start(new ProcessStartInfo
        {
            FileName = node,
            Arguments = "server.js",
            WorkingDirectory = AppDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden
        });
        if (_serverProcess is not null)
        {
            _serverProcess.EnableRaisingEvents = true;
            _serverProcess.Exited += (_, _) => CloseAfterServerExit();
        }
    }

    private void CloseAfterServerExit()
    {
        if (_closing || IsDisposed || !IsHandleCreated) return;
        try
        {
            BeginInvoke(() =>
            {
                if (!_closing && !IsDisposed) Close();
            });
        }
        catch (InvalidOperationException)
        {
            // The launcher is already closing.
        }
    }

    private static string? FindNode()
    {
        var localNode = Path.Combine(AppDirectory, "node.exe");
        if (File.Exists(localNode)) return localNode;

        var pathValue = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var directory in pathValue.Split(Path.PathSeparator))
        {
            try
            {
                var candidate = Path.Combine(directory.Trim(), "node.exe");
                if (File.Exists(candidate)) return candidate;
            }
            catch
            {
                // Ignore invalid PATH entries.
            }
        }

        return null;
    }

    private static bool IsPortOpen()
    {
        try
        {
            using var client = new TcpListenerProbe();
            return client.CanConnect("127.0.0.1", 5177);
        }
        catch
        {
            return false;
        }
    }

    private async Task PollServerAsync()
    {
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
            using var response = await client.GetAsync($"{AppUrl}api/state");
            if (response.StatusCode == HttpStatusCode.OK)
            {
                _serverWasReady = true;
                _serverFailureCount = 0;
                _status.Text = $"실행 중입니다.\r\n조작 화면: {AppUrl}\r\nOBS Overlay: {OverlayUrl}";
                _openApp.Enabled = true;

                if (!_controlPageOpened && OpenControlPage())
                {
                    _controlPageOpened = true;
                }
            }
        }
        catch
        {
            if (!_serverWasReady) return;

            _serverFailureCount += 1;
            if (_serverProcess?.HasExited == true || _serverFailureCount >= 3)
            {
                _status.Text = "로컬 서버가 종료되었습니다.";
                _openApp.Enabled = false;
                _pollTimer.Stop();
                BeginInvoke(Close);
            }
        }
    }

    private void StopServer()
    {
        _pollTimer.Stop();
        RequestServerShutdown();
        try
        {
            if (_serverProcess is { HasExited: false })
            {
                _serverProcess.Kill(entireProcessTree: true);
                _serverProcess.Dispose();
            }
        }
        catch
        {
            // Nothing else to do while closing.
        }
    }

    private static void RequestServerShutdown()
    {
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromMilliseconds(800) };
            using var request = new HttpRequestMessage(HttpMethod.Post, $"{AppUrl}api/shutdown");
            client.Send(request);
        }
        catch
        {
            // The server may already be closed or blocked by another process.
        }
    }

    private sealed class TcpListenerProbe : IDisposable
    {
        public bool CanConnect(string host, int port)
        {
            using var client = new System.Net.Sockets.TcpClient();
            var task = client.ConnectAsync(host, port);
            return task.Wait(TimeSpan.FromMilliseconds(250)) && client.Connected;
        }

        public void Dispose()
        {
        }
    }
}
