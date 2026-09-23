using System.Diagnostics;
using System.Net;
using System.Net.Http;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ObsKaraokeLauncher;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        using var instance = new Mutex(true, "Local\\OBS-Karaoke-Desktop", out var firstInstance);
        if (!firstInstance)
        {
            MessageBox.Show("OBS Karaoke가 이미 실행 중입니다.", "OBS Karaoke MVP");
            return;
        }
        ApplicationConfiguration.Initialize();
        using var form = new LauncherForm();
        Application.Run(form);
        form.StartPendingUpdate();
    }
}

public sealed class LauncherForm : Form
{
    private const string AppUrl = "http://127.0.0.1:5177/";
    private const string OverlayUrl = "http://127.0.0.1:5177/overlay?v=20260823-mismatch-cancel-1";
    private const string ManifestUrl =
        "https://github.com/tobi31231/obs-karaoke/releases/latest/download/release-manifest.json";
    private const string InstallerUrl =
        "https://github.com/tobi31231/obs-karaoke/releases/latest/download/OBS-Karaoke-Setup.exe";

    private readonly Label _status = new();
    private readonly Label _loadingMessage = new();
    private readonly ProgressBar _loadingProgress = new();
    private readonly Button _retry = new();
    private readonly Button _reload = new();
    private readonly WebView2 _webView = new();
    private readonly Panel _loadingPanel = new();
    private readonly System.Windows.Forms.Timer _pollTimer = new();
    private readonly CancellationTokenSource _updateCancellation = new();

    private Process? _serverProcess;
    private Process? _browserProcess;
    private readonly ProcessJob _ownedProcesses = new();
    private readonly string _userDataDirectory = Path.Combine(Path.GetTempPath(), "OBS-Karaoke", Guid.NewGuid().ToString("N"));
    private bool _serverWasReady;
    private bool _webViewInitializing;
    private bool _webViewReady;
    private volatile bool _closing;
    private bool _shutdownComplete;
    private bool _polling;
    private string? _pendingInstaller;
    private int _serverFailureCount;

    public LauncherForm()
    {
        ClearStaleProfiles();
        Text = "OBS Karaoke MVP";
        AutoScaleMode = AutoScaleMode.Dpi;
        var workingArea = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1366, 768);
        ClientSize = new Size(
            Math.Min(1280, Math.Max(900, workingArea.Width - 80)),
            Math.Min(820, Math.Max(640, workingArea.Height - 80)));
        MinimumSize = new Size(900, 640);
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.Sizable;
        MaximizeBox = true;
        SizeGripStyle = SizeGripStyle.Show;

        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 3,
            Margin = new Padding(0),
            Padding = new Padding(0)
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 58));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 32));

        var toolbar = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            BackColor = Color.FromArgb(247, 248, 250),
            ColumnCount = 4,
            RowCount = 1,
            Padding = new Padding(18, 10, 14, 10),
            Margin = new Padding(0)
        };
        toolbar.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        toolbar.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        toolbar.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        toolbar.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));

        var title = new Label
        {
            Text = "OBS Karaoke MVP",
            Dock = DockStyle.Fill,
            Font = new Font("Segoe UI", 13, FontStyle.Bold),
            TextAlign = ContentAlignment.MiddleLeft,
            Margin = new Padding(0)
        };

        var copyOverlay = CreateToolbarButton("Overlay 주소 복사");
        copyOverlay.Click += (_, _) =>
        {
            Clipboard.SetText(OverlayUrl);
            _status.Text = "OBS Browser Source 주소를 복사했습니다.";
        };

        _reload.Text = "새로고침";
        ConfigureToolbarButton(_reload);
        _reload.Enabled = false;
        _reload.Click += async (_, _) => await ReloadControlPageAsync();

        var stop = CreateToolbarButton("종료");
        stop.Click += (_, _) => Close();

        toolbar.Controls.Add(title, 0, 0);
        toolbar.Controls.Add(copyOverlay, 1, 0);
        toolbar.Controls.Add(_reload, 2, 0);
        toolbar.Controls.Add(stop, 3, 0);

        var content = new Panel
        {
            Dock = DockStyle.Fill,
            BackColor = Color.White,
            Margin = new Padding(0)
        };
        _webView.Dock = DockStyle.Fill;
        _webView.Visible = false;
        content.Controls.Add(_webView);

        _loadingPanel.Dock = DockStyle.Fill;
        _loadingPanel.BackColor = Color.White;
        var loadingLayout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 5,
            Padding = new Padding(24)
        };
        loadingLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        loadingLayout.RowStyles.Add(new RowStyle(SizeType.Percent, 50));
        loadingLayout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        loadingLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));
        loadingLayout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        loadingLayout.RowStyles.Add(new RowStyle(SizeType.Percent, 50));

        _loadingMessage.Text = "로컬 실행 환경을 준비하는 중입니다...";
        _loadingMessage.AutoSize = true;
        _loadingMessage.Anchor = AnchorStyles.None;
        _loadingMessage.Font = new Font("Segoe UI", 12, FontStyle.Regular);
        _loadingMessage.TextAlign = ContentAlignment.MiddleCenter;
        _loadingMessage.Margin = new Padding(0, 0, 0, 12);

        _loadingProgress.Style = ProgressBarStyle.Marquee;
        _loadingProgress.MarqueeAnimationSpeed = 28;
        _loadingProgress.Width = 320;
        _loadingProgress.Height = 8;
        _loadingProgress.Anchor = AnchorStyles.None;

        _retry.Text = "다시 시도";
        _retry.AutoSize = true;
        _retry.MinimumSize = new Size(110, 36);
        _retry.Anchor = AnchorStyles.None;
        _retry.Visible = false;
        _retry.Click += async (_, _) => await RetryAsync();

        loadingLayout.Controls.Add(new Panel(), 0, 0);
        loadingLayout.Controls.Add(_loadingMessage, 0, 1);
        loadingLayout.Controls.Add(_loadingProgress, 0, 2);
        loadingLayout.Controls.Add(_retry, 0, 3);
        loadingLayout.Controls.Add(new Panel(), 0, 4);
        _loadingPanel.Controls.Add(loadingLayout);
        content.Controls.Add(_loadingPanel);
        _loadingPanel.BringToFront();

        _status.Text = $"시작 중 · OBS Overlay: {OverlayUrl}";
        _status.Dock = DockStyle.Fill;
        _status.BackColor = Color.FromArgb(247, 248, 250);
        _status.ForeColor = Color.FromArgb(70, 75, 84);
        _status.TextAlign = ContentAlignment.MiddleLeft;
        _status.Padding = new Padding(18, 0, 10, 0);
        _status.Margin = new Padding(0);
        _status.AutoEllipsis = true;

        layout.Controls.Add(toolbar, 0, 0);
        layout.Controls.Add(content, 0, 1);
        layout.Controls.Add(_status, 0, 2);
        Controls.Add(layout);

        _pollTimer.Interval = 700;
        _pollTimer.Tick += async (_, _) => await PollServerAsync();
        Shown += async (_, _) =>
        {
            StartServer();
            _pollTimer.Start();
            await PollServerAsync();
            _ = CheckForUpdatesAsync();
        };
        FormClosing += async (_, args) =>
        {
            if (_shutdownComplete) return;
            args.Cancel = true;
            if (_closing) return;
            _closing = true;
            _updateCancellation.Cancel();
            _pollTimer.Stop();
            Enabled = false;
            _status.Text = "앱과 분석 작업을 종료하는 중입니다...";
            try
            {
                _webView.CoreWebView2?.Stop();
                _webView.Dispose();
            }
            catch
            {
                // The WebView may already have closed after a renderer failure.
            }
            await Task.Run(() =>
            {
                StopServer();
                try
                {
                    if (_browserProcess is { HasExited: false } && !_browserProcess.WaitForExit(2000))
                        _browserProcess.Kill(entireProcessTree: true);
                    _browserProcess?.WaitForExit(1000);
                }
                catch (InvalidOperationException) { }
                catch (System.ComponentModel.Win32Exception) { }
                finally
                {
                    _ownedProcesses.Dispose();
                    _browserProcess?.Dispose();
                }
                try { Directory.Delete(_userDataDirectory, recursive: true); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            });
            _shutdownComplete = true;
            Close();
        };
    }

    private static string AppDirectory => AppContext.BaseDirectory;

    private async Task CheckForUpdatesAsync()
    {
        var receipt = Path.Combine(AppDirectory, "release-manifest.json");
        if (!File.Exists(receipt)) return;
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(8) };
            var update = await UpdateChecker.CheckAsync(receipt, new Uri(ManifestUrl),
                new Uri(InstallerUrl), client, _updateCancellation.Token);
            if (update is null || _closing) return;

            var choice = MessageBox.Show(this,
                $"새 패치가 있습니다 ({update.Version}). 지금 설치하시겠습니까?\n진행 중인 작업은 종료됩니다.",
                "OBS Karaoke MVP 업데이트", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (choice != DialogResult.Yes || _closing) return;

            _status.Text = "업데이트 설치 파일 다운로드 및 검증 중...";
            var folder = Path.Combine(Path.GetTempPath(), $"obs-karaoke-update-{Guid.NewGuid():N}");
            var installer = Path.Combine(folder, "OBS-Karaoke-Setup.exe");
            using var downloadClient = new HttpClient { Timeout = TimeSpan.FromMinutes(30) };
            var progress = new Progress<(long Downloaded, long? Total)>(item =>
            {
                if (_closing) return;
                var current = item.Downloaded / 1048576;
                var total = item.Total.HasValue ? $" / {item.Total.Value / 1048576} MB" : " MB";
                _status.Text = $"업데이트 다운로드 중: {current}{total}";
            });
            await UpdateChecker.DownloadInstallerAsync(update, installer, downloadClient,
                _updateCancellation.Token, progress);
            if (_closing) return;
            _pendingInstaller = installer;
            Close();
        }
        catch (OperationCanceledException) { }
        catch (Exception error)
        {
            if (_closing) return;
            _status.Text = "업데이트 확인/다운로드에 실패했습니다. 현재 버전은 계속 사용할 수 있습니다.";
            MessageBox.Show(this, error.Message, "업데이트 실패", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    public void StartPendingUpdate()
    {
        if (_pendingInstaller is null) return;
        var info = new ProcessStartInfo
        {
            FileName = _pendingInstaller,
            WorkingDirectory = Path.GetDirectoryName(_pendingInstaller)!,
            UseShellExecute = true
        };
        info.ArgumentList.Add("--install-dir");
        info.ArgumentList.Add(Path.TrimEndingDirectorySeparator(AppDirectory));
        info.ArgumentList.Add("--auto-install");
        try { Process.Start(info); }
        catch (Exception error)
        {
            MessageBox.Show($"설치기를 열지 못했습니다: {error.Message}\n{_pendingInstaller}",
                "업데이트 실패", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private static void ClearStaleProfiles()
    {
        // The single-instance mutex is held; these are only this app's crash leftovers.
        var root = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "OBS-Karaoke"));
        if (!Directory.Exists(root)) return;
        foreach (var directory in Directory.EnumerateDirectories(root))
        {
            var fullPath = Path.GetFullPath(directory);
            if (!fullPath.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
                || !Guid.TryParseExact(Path.GetFileName(fullPath), "N", out _)) continue;
            try
            {
                if ((File.GetAttributes(fullPath) & FileAttributes.ReparsePoint) == 0)
                    Directory.Delete(fullPath, recursive: true);
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }

    private static Button CreateToolbarButton(string text)
    {
        var button = new Button { Text = text };
        ConfigureToolbarButton(button);
        return button;
    }

    private static void ConfigureToolbarButton(Button button)
    {
        button.AutoSize = true;
        button.MinimumSize = new Size(96, 34);
        button.Margin = new Padding(8, 0, 0, 0);
        button.Padding = new Padding(10, 0, 10, 0);
    }

    private void StartServer()
    {
        if (IsPortOpen())
        {
            ShowError("5177 포트가 사용 중입니다. 이전 실행 앱을 종료한 뒤 다시 시도해 주세요.");
            return;
        }

        var serverPath = Path.Combine(AppDirectory, "server.js");
        if (!File.Exists(serverPath))
        {
            ShowError("server.js 파일을 찾을 수 없습니다. 앱을 다시 설치해 주세요.");
            return;
        }

        var node = FindNode();
        if (node is null)
        {
            ShowError("Node.js 실행 파일을 찾을 수 없습니다. 앱을 다시 설치해 주세요.");
            return;
        }

        ShowLoading("로컬 서버를 시작하는 중입니다...");
        var startInfo = new ProcessStartInfo
        {
            FileName = node,
            Arguments = "server.js",
            WorkingDirectory = AppDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden
        };
        startInfo.Environment["OBS_KARAOKE_DESKTOP"] = "1";
        _serverProcess = Process.Start(startInfo);
        if (_serverProcess is not null)
        {
            _ownedProcesses.Add(_serverProcess);
            _serverProcess.EnableRaisingEvents = true;
            _serverProcess.Exited += (_, _) => CloseAfterServerExit();
        }
    }

    private async Task InitializeWebViewAsync()
    {
        if (_webViewReady || _webViewInitializing || _closing) return;
        _webViewInitializing = true;
        ShowLoading("앱 조작 화면을 여는 중입니다...");

        try
        {
            if (_webView.CoreWebView2 is not null)
            {
                _webView.CoreWebView2.Navigate(AppUrl);
                return;
            }

            Directory.CreateDirectory(_userDataDirectory);
            var environment = await CoreWebView2Environment.CreateAsync(
                userDataFolder: _userDataDirectory);
            if (_closing) return;
            await _webView.EnsureCoreWebView2Async(environment);
            if (_closing) { _webView.Dispose(); return; }

            var core = _webView.CoreWebView2
                ?? throw new InvalidOperationException("WebView2 초기화가 완료되지 않았습니다.");
            _browserProcess = Process.GetProcessById((int)core.BrowserProcessId);
            _ownedProcesses.Add(_browserProcess);
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.ProcessFailed += (_, _) =>
                BeginInvoke(() => ShowError("내장 화면이 중단되었습니다. 다시 시도해 주세요."));
            core.NewWindowRequested += (_, args) => args.Handled = true;
            _webView.NavigationCompleted += (_, args) =>
            {
                if (args.IsSuccess)
                {
                    _webViewReady = true;
                    _webView.Visible = true;
                    _loadingPanel.Visible = false;
                    _reload.Enabled = true;
                    _status.Text = $"실행 중 · OBS Overlay: {OverlayUrl}";
                }
                else
                {
                    ShowError($"조작 화면을 열지 못했습니다. ({args.WebErrorStatus})");
                }
            };
            _webView.Source = new Uri(AppUrl);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            ShowError("Microsoft Edge WebView2 Runtime이 없습니다. 최신 설치 프로그램으로 다시 설치해 주세요.");
        }
        catch (Exception error)
        {
            ShowError($"조작 화면을 준비하지 못했습니다: {error.Message}");
        }
        finally
        {
            _webViewInitializing = false;
        }
    }

    private async Task ReloadControlPageAsync()
    {
        if (!IsPortOpen())
        {
            await RetryAsync();
            return;
        }

        ShowLoading("조작 화면을 새로고침하는 중입니다...");
        if (_webView.CoreWebView2 is not null)
        {
            _webView.CoreWebView2.Navigate(AppUrl);
        }
        else
        {
            await InitializeWebViewAsync();
        }
    }

    private async Task RetryAsync()
    {
        _retry.Enabled = false;
        _serverFailureCount = 0;
        if (!IsPortOpen()) StartServer();
        await PollServerAsync();
        _retry.Enabled = true;
    }

    private void ShowLoading(string message)
    {
        if (_closing || IsDisposed) return;
        _loadingMessage.Text = message;
        _loadingProgress.Visible = true;
        _retry.Visible = false;
        _webView.Visible = false;
        _loadingPanel.Visible = true;
        _loadingPanel.BringToFront();
    }

    private void ShowError(string message)
    {
        if (_closing || IsDisposed) return;
        _loadingMessage.Text = message;
        _loadingProgress.Visible = false;
        _retry.Visible = true;
        _webViewReady = false;
        _reload.Enabled = false;
        _webView.Visible = false;
        _loadingPanel.Visible = true;
        _loadingPanel.BringToFront();
        _status.Text = message;
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
            // The app is already closing.
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
        if (_closing || _polling || _serverProcess is null) return;
        _polling = true;
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
            using var response = await client.GetAsync($"{AppUrl}api/state");
            if (response.StatusCode != HttpStatusCode.OK) return;

            _serverWasReady = true;
            _serverFailureCount = 0;
            _status.Text = $"실행 중 · OBS Overlay: {OverlayUrl}";
            if (!_webViewReady) await InitializeWebViewAsync();
        }
        catch
        {
            if (!_serverWasReady) return;

            _serverFailureCount += 1;
            if (_serverProcess?.HasExited == true || _serverFailureCount >= 3)
            {
                _pollTimer.Stop();
                ShowError("로컬 서버가 종료되었습니다. 다시 시도해 주세요.");
            }
        }
        finally { _polling = false; }
    }

    private void StopServer()
    {
        if (_serverProcess is null) return;
        RequestServerShutdown();
        try
        {
            if (_serverProcess is { HasExited: false })
            {
                if (!_serverProcess.WaitForExit(1800)) _serverProcess.Kill(entireProcessTree: true);
                _serverProcess.WaitForExit(1000);
            }
            _serverProcess?.Dispose();
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
            // The server may already be closed.
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
