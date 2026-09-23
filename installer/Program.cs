using System.Diagnostics;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Win32;

namespace ObsKaraokeSetup;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Contains("--verify-assets", StringComparer.OrdinalIgnoreCase))
        {
            try
            {
                InstallerForm.VerifyLocalAssetsAsync().GetAwaiter().GetResult();
                Environment.ExitCode = 0;
            }
            catch
            {
                Environment.ExitCode = 1;
            }
            return;
        }

        ApplicationConfiguration.Initialize();
        var target = args.SkipWhile(value => value != "--install-dir").Skip(1).FirstOrDefault();
        var autoInstall = args.Contains("--auto-install", StringComparer.OrdinalIgnoreCase);
        Application.Run(new InstallerForm(target, autoInstall));
    }
}

public sealed class InstallerForm : Form
{
    private const string AppFolderName = "OBS Karaoke MVP";
    private const string RemoteManifestUrl =
        "https://github.com/tobi31231/obs-karaoke/releases/latest/download/release-manifest.json";
    private const string WebView2BootstrapperUrl =
        "https://go.microsoft.com/fwlink/p/?LinkId=2124703";
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromHours(2) };
    private static readonly string DefaultInstallDirectory =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), AppFolderName);

    private readonly Label _status = new();
    private readonly TextBox _installPath = new();
    private readonly Button _browse = new();
    private readonly ProgressBar _progress = new();
    private readonly Button _install = new();
    private readonly Button _cancel = new();
    private readonly bool _autoInstall;
    private CancellationTokenSource? _cancellation;

    public InstallerForm(string? installDirectory = null, bool autoInstall = false)
    {
        _autoInstall = autoInstall;
        Text = "OBS Karaoke MVP 설치";
        AutoScaleMode = AutoScaleMode.Dpi;
        AutoScroll = true;
        ClientSize = new Size(720, 430);
        MinimumSize = new Size(600, 390);
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.Sizable;
        MaximizeBox = true;
        SizeGripStyle = SizeGripStyle.Show;

        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 7,
            Padding = new Padding(28)
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 32));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));

        var title = new Label
        {
            Text = "OBS Karaoke MVP",
            Font = new Font(Font.FontFamily, 17, FontStyle.Bold),
            AutoSize = true,
            Margin = new Padding(0, 0, 0, 8)
        };
        var description = new Label
        {
            Text = "Turbo 모델과 로컬 실행 환경을 설치합니다.",
            AutoSize = true,
            Margin = new Padding(0, 0, 0, 18)
        };

        var pathLabel = new Label
        {
            Text = "설치 폴더",
            AutoSize = true,
            Margin = new Padding(0, 0, 0, 7)
        };
        _installPath.Text = installDirectory ?? DefaultInstallDirectory;
        _installPath.Dock = DockStyle.Fill;
        _installPath.Margin = new Padding(0, 3, 8, 3);
        _browse.Text = "찾아보기...";
        _browse.AutoSize = true;
        _browse.MinimumSize = new Size(112, 32);
        _browse.Click += (_, _) => ChooseInstallDirectory();

        var pathRow = new TableLayoutPanel
        {
            AutoSize = true,
            Dock = DockStyle.Fill,
            ColumnCount = 2,
            Margin = new Padding(0, 0, 0, 14)
        };
        pathRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        pathRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        pathRow.Controls.Add(_installPath, 0, 0);
        pathRow.Controls.Add(_browse, 1, 0);

        _status.Text = "설치 버튼을 누르면 필요한 파일을 내려받습니다.";
        _status.AutoEllipsis = true;
        _status.Dock = DockStyle.Fill;
        _status.TextAlign = ContentAlignment.MiddleLeft;
        _status.MinimumSize = new Size(0, 72);
        _status.Margin = new Padding(0, 0, 0, 14);
        _progress.Dock = DockStyle.Fill;
        _progress.Margin = new Padding(0, 3, 0, 7);
        _install.Text = "설치";
        _install.Size = new Size(110, 38);
        _install.Click += async (_, _) => await InstallAsync();
        _cancel.Text = "닫기";
        _cancel.Size = new Size(110, 38);
        _cancel.Click += (_, _) =>
        {
            if (_cancellation is null) Close();
            else _cancellation.Cancel();
        };

        var buttonRow = new FlowLayoutPanel
        {
            AutoSize = true,
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.RightToLeft,
            WrapContents = false,
            Margin = new Padding(0, 16, 0, 0)
        };
        buttonRow.Controls.AddRange([_cancel, _install]);

        layout.Controls.Add(title, 0, 0);
        layout.Controls.Add(description, 0, 1);
        layout.Controls.Add(pathLabel, 0, 2);
        layout.Controls.Add(pathRow, 0, 3);
        layout.Controls.Add(_status, 0, 4);
        layout.Controls.Add(_progress, 0, 5);
        layout.Controls.Add(buttonRow, 0, 6);
        Controls.Add(layout);

        AcceptButton = _install;
        CancelButton = _cancel;
        if (autoInstall) Shown += async (_, _) => await InstallAsync();
    }

    private void ChooseInstallDirectory()
    {
        var initialDirectory = FindExistingDirectory(_installPath.Text) ??
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        using var dialog = new FolderBrowserDialog
        {
            Description = $"설치할 위치를 선택하세요. 선택한 위치 안에 {AppFolderName} 폴더가 생성됩니다.",
            UseDescriptionForTitle = true,
            SelectedPath = initialDirectory,
            ShowNewFolderButton = true
        };
        if (dialog.ShowDialog(this) != DialogResult.OK) return;

        var selected = Path.GetFullPath(dialog.SelectedPath);
        _installPath.Text = string.Equals(
            Path.GetFileName(Path.TrimEndingDirectorySeparator(selected)),
            AppFolderName,
            StringComparison.OrdinalIgnoreCase)
            ? selected
            : Path.Combine(selected, AppFolderName);
        _status.Text = $"설치 위치: {_installPath.Text}";
    }

    private static string? FindExistingDirectory(string path)
    {
        try
        {
            var candidate = Environment.ExpandEnvironmentVariables(path.Trim());
            while (!string.IsNullOrWhiteSpace(candidate))
            {
                if (Directory.Exists(candidate)) return Path.GetFullPath(candidate);
                candidate = Path.GetDirectoryName(candidate);
            }
        }
        catch
        {
            // The typed path will be validated when installation starts.
        }
        return null;
    }

    private string ResolveInstallDirectory()
    {
        var value = Environment.ExpandEnvironmentVariables(_installPath.Text.Trim());
        if (string.IsNullOrWhiteSpace(value))
            throw new InvalidDataException("설치 폴더를 입력하세요.");

        var fullPath = Path.TrimEndingDirectorySeparator(Path.GetFullPath(value));
        var root = Path.GetPathRoot(fullPath);
        if (string.IsNullOrWhiteSpace(root) || string.Equals(
            fullPath,
            Path.TrimEndingDirectorySeparator(root),
            StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException("드라이브 최상위 경로에는 직접 설치할 수 없습니다.");
        }

        if (Directory.Exists(fullPath) && Directory.EnumerateFileSystemEntries(fullPath).Any())
        {
            var existingExecutable = Path.Combine(fullPath, "OBS Karaoke MVP.exe");
            var existingServer = Path.Combine(fullPath, "server.js");
            if (!File.Exists(existingExecutable) || !File.Exists(existingServer))
            {
                throw new InvalidDataException(
                    "선택한 폴더에 다른 파일이 있습니다. 비어 있는 폴더나 기존 OBS Karaoke MVP 설치 폴더를 선택하세요.");
            }
        }

        return fullPath;
    }

    private static string CreateStagingDirectory(string installDirectory)
    {
        var parent = Directory.GetParent(installDirectory)?.FullName
            ?? throw new InvalidDataException("설치 폴더의 상위 경로를 확인할 수 없습니다.");
        Directory.CreateDirectory(parent);
        var staging = Path.Combine(parent, $".{AppFolderName}.installing-{Guid.NewGuid():N}");
        Directory.CreateDirectory(staging);
        return staging;
    }

    internal static async Task VerifyLocalAssetsAsync()
    {
        var temporary = Path.Combine(Path.GetTempPath(), $"obs-karaoke-verify-{Guid.NewGuid():N}");
        Directory.CreateDirectory(temporary);
        try
        {
            var (manifest, manifestUri) = await LoadManifestAsync(CancellationToken.None);
            foreach (var asset in manifest.Assets)
            {
                var archive = await GetAssetAsync(asset, manifestUri, temporary, CancellationToken.None);
                await VerifyHashAsync(archive, asset.Sha256, CancellationToken.None);
                ExtractSafely(archive, temporary);
            }

            foreach (var relativePath in new[]
            {
                "OBS Karaoke MVP.exe",
                @"models\faster-whisper-turbo\model.bin",
                @"runtime\cuda\bin\cublas64_12.dll",
                @"python\python.exe",
                "node.exe"
            })
            {
                if (!File.Exists(Path.Combine(temporary, relativePath)))
                {
                    throw new InvalidDataException($"설치 결과에 파일이 없습니다: {relativePath}");
                }
            }
        }
        finally
        {
            TryDeleteDirectory(temporary);
        }
    }

    private async Task InstallAsync()
    {
        string installDirectory;
        try
        {
            installDirectory = ResolveInstallDirectory();
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        _cancellation = new CancellationTokenSource();
        _install.Enabled = false;
        _installPath.Enabled = false;
        _browse.Enabled = false;
        _cancel.Text = "취소";
        _progress.Style = ProgressBarStyle.Marquee;

        string? staging = null;
        var downloadDirectory = Path.Combine(Path.GetTempPath(), $"obs-karaoke-setup-{Guid.NewGuid():N}");

        try
        {
            staging = CreateStagingDirectory(installDirectory);
            Directory.CreateDirectory(downloadDirectory);
            var (manifest, manifestUri) = await LoadManifestAsync(_cancellation.Token);
            var existingManifestPath = Path.Combine(installDirectory, "release-manifest.json");
            ReleaseManifest? installedManifest = null;
            try
            {
                if (File.Exists(existingManifestPath))
                    installedManifest = DeserializeManifest(await File.ReadAllTextAsync(existingManifestPath, _cancellation.Token));
            }
            catch (Exception error) when (error is IOException or JsonException or InvalidDataException)
            {
                // An older installation can still be updated with fresh downloads.
            }

            _status.Text = "내장 조작 화면 구성요소 확인/설치 중...";
            await EnsureWebView2RuntimeAsync(downloadDirectory, _cancellation.Token);

            foreach (var asset in manifest.Assets)
            {
                _cancellation.Token.ThrowIfCancellationRequested();
                var reusableDirectory = asset.Name switch
                {
                    "obs-karaoke-turbo-model.zip" => "models",
                    "obs-karaoke-cuda-runtime-win-x64.zip" => "runtime",
                    _ => null
                };
                var installedAsset = installedManifest?.Assets.FirstOrDefault(item => item.Name == asset.Name);
                if (reusableDirectory is not null && LocalAssetReuse.CanReuse(
                        Path.Combine(installDirectory, reusableDirectory), asset.Sha256, installedAsset?.Sha256))
                {
                    _status.Text = $"기존 파일 재사용 중: {reusableDirectory}";
                    await Task.Run(() => LocalAssetReuse.CopyTree(
                        Path.Combine(installDirectory, reusableDirectory),
                        Path.Combine(staging, reusableDirectory), _cancellation.Token), _cancellation.Token);
                    continue;
                }
                _status.Text = $"받는 중: {asset.Name}";
                var archive = await GetAssetAsync(asset, manifestUri, downloadDirectory, _cancellation.Token);
                await VerifyHashAsync(archive, asset.Sha256, _cancellation.Token);
                _status.Text = $"설치 중: {asset.Name}";
                await Task.Run(() => ExtractSafely(archive, staging), _cancellation.Token);
            }

            var executable = Path.Combine(staging, "OBS Karaoke MVP.exe");
            if (!File.Exists(executable))
            {
                throw new InvalidDataException("설치 패키지에 실행 파일이 없습니다.");
            }

            await File.WriteAllTextAsync(
                Path.Combine(staging, "release-manifest.json"),
                JsonSerializer.Serialize(manifest), _cancellation.Token);

            _status.Text = "설치 마무리 중...";
            InstallStagingDirectory(staging, installDirectory);
            staging = null;
            CreateDesktopShortcut(installDirectory);
            _progress.Style = ProgressBarStyle.Continuous;
            _progress.Value = 100;
            _status.Text = $"설치 완료: {manifest.Version}\r\n{installDirectory}";
            _cancel.Text = "닫기";
            _cancellation.Dispose();
            _cancellation = null;

            Process.Start(new ProcessStartInfo
            {
                FileName = Path.Combine(installDirectory, "OBS Karaoke MVP.exe"),
                WorkingDirectory = installDirectory,
                UseShellExecute = true
            });
            if (_autoInstall) Close();
        }
        catch (OperationCanceledException)
        {
            _status.Text = "설치를 취소했습니다.";
            _progress.Style = ProgressBarStyle.Continuous;
            _progress.Value = 0;
        }
        catch (Exception error)
        {
            _status.Text = "설치에 실패했습니다.";
            MessageBox.Show(error.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            _progress.Style = ProgressBarStyle.Continuous;
            _progress.Value = 0;
        }
        finally
        {
            if (staging is not null) TryDeleteDirectory(staging);
            TryDeleteDirectory(downloadDirectory);
            _cancellation?.Dispose();
            _cancellation = null;
            _install.Enabled = true;
            _installPath.Enabled = true;
            _browse.Enabled = true;
            _cancel.Text = "닫기";
        }
    }

    private static async Task<(ReleaseManifest Manifest, Uri Source)> LoadManifestAsync(
        CancellationToken cancellationToken)
    {
        var localPath = Path.Combine(AppContext.BaseDirectory, "release-manifest.json");
        if (File.Exists(localPath))
        {
            var json = await File.ReadAllTextAsync(localPath, cancellationToken);
            return (DeserializeManifest(json), new Uri(localPath));
        }

        if (RemoteManifestUrl.Contains("OWNER/REPOSITORY", StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                "GitHub 저장소 주소가 아직 설정되지 않았습니다. 로컬 테스트는 설치 파일 옆에 release-manifest.json을 두세요.");
        }

        using var response = await Http.GetAsync(RemoteManifestUrl, cancellationToken);
        response.EnsureSuccessStatusCode();
        var content = await response.Content.ReadAsStringAsync(cancellationToken);

        // GitHub redirects the manifest to a signed CDN URL that is valid for
        // that file only. Build sibling asset URLs from the stable Release URL.
        return (DeserializeManifest(content), new Uri(RemoteManifestUrl));
    }

    private static ReleaseManifest DeserializeManifest(string json)
    {
        var manifest = JsonSerializer.Deserialize<ReleaseManifest>(
            json,
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        if (manifest is null || manifest.Assets.Count == 0)
        {
            throw new InvalidDataException("배포 manifest가 비어 있습니다.");
        }
        return manifest;
    }

    private static async Task<string> GetAssetAsync(
        ReleaseAsset asset,
        Uri manifestUri,
        string downloadDirectory,
        CancellationToken cancellationToken)
    {
        var fileName = Path.GetFileName(asset.Name);
        if (!string.Equals(fileName, asset.Name, StringComparison.Ordinal))
        {
            throw new InvalidDataException($"잘못된 배포 파일 이름: {asset.Name}");
        }

        var localAsset = Path.Combine(AppContext.BaseDirectory, fileName);
        if (File.Exists(localAsset)) return localAsset;

        var target = Path.Combine(downloadDirectory, fileName);
        var assetUri = new Uri(manifestUri, Uri.EscapeDataString(fileName));
        using var response = await Http.GetAsync(
            assetUri,
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken);
        response.EnsureSuccessStatusCode();
        await using var source = await response.Content.ReadAsStreamAsync(cancellationToken);
        await using var destination = new FileStream(
            target,
            FileMode.Create,
            FileAccess.Write,
            FileShare.None,
            1024 * 1024,
            useAsync: true);
        await source.CopyToAsync(destination, cancellationToken);
        return target;
    }

    private static async Task EnsureWebView2RuntimeAsync(
        string downloadDirectory,
        CancellationToken cancellationToken)
    {
        if (IsWebView2RuntimeInstalled()) return;

        var bootstrapper = Path.Combine(downloadDirectory, "MicrosoftEdgeWebview2Setup.exe");
        using (var response = await Http.GetAsync(
                   WebView2BootstrapperUrl,
                   HttpCompletionOption.ResponseHeadersRead,
                   cancellationToken))
        {
            response.EnsureSuccessStatusCode();
            await using var source = await response.Content.ReadAsStreamAsync(cancellationToken);
            await using var destination = new FileStream(
                bootstrapper,
                FileMode.Create,
                FileAccess.Write,
                FileShare.None,
                64 * 1024,
                useAsync: true);
            await source.CopyToAsync(destination, cancellationToken);
        }

        using var process = Process.Start(new ProcessStartInfo
        {
            FileName = bootstrapper,
            Arguments = "/silent /install",
            WorkingDirectory = downloadDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden
        }) ?? throw new InvalidOperationException("WebView2 Runtime 설치 프로그램을 시작하지 못했습니다.");

        try
        {
            await process.WaitForExitAsync(cancellationToken);
        }
        catch (OperationCanceledException)
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
            throw;
        }

        if (process.ExitCode is not 0 and not 3010)
        {
            throw new InvalidOperationException(
                $"WebView2 Runtime 설치에 실패했습니다. (종료 코드: {process.ExitCode})");
        }
    }

    private static bool IsWebView2RuntimeInstalled()
    {
        const string clientPath =
            @"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

        foreach (var hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
        {
            foreach (var view in new[] { RegistryView.Registry32, RegistryView.Registry64 })
            {
                try
                {
                    using var baseKey = RegistryKey.OpenBaseKey(hive, view);
                    using var key = baseKey.OpenSubKey(clientPath);
                    var versionText = key?.GetValue("pv") as string;
                    if (Version.TryParse(versionText, out var version) && version > new Version(0, 0, 0, 0))
                    {
                        return true;
                    }
                }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException)
                {
                    // Continue with the next registry hive/view.
                }
            }
        }

        return false;
    }

    private static async Task VerifyHashAsync(
        string path,
        string expected,
        CancellationToken cancellationToken)
    {
        await using var stream = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            1024 * 1024,
            useAsync: true);
        using var sha = SHA256.Create();
        var actual = Convert.ToHexString(await sha.ComputeHashAsync(stream, cancellationToken));
        if (!actual.Equals(expected, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException($"파일 검증 실패: {Path.GetFileName(path)}");
        }
    }

    private static void ExtractSafely(string archivePath, string destinationRoot)
    {
        var root = Path.GetFullPath(destinationRoot) + Path.DirectorySeparatorChar;
        using var archive = ZipFile.OpenRead(archivePath);
        foreach (var entry in archive.Entries)
        {
            var destination = Path.GetFullPath(Path.Combine(destinationRoot, entry.FullName));
            if (!destination.StartsWith(root, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException($"잘못된 ZIP 경로: {entry.FullName}");
            }

            if (string.IsNullOrEmpty(entry.Name))
            {
                Directory.CreateDirectory(destination);
                continue;
            }

            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            entry.ExtractToFile(destination, overwrite: true);
        }
    }

    private static void InstallStagingDirectory(string staging, string installDirectory)
    {
        var backup = installDirectory + ".old";
        TryDeleteDirectory(backup);
        if (Directory.Exists(installDirectory))
        {
            Directory.Move(installDirectory, backup);
        }

        try
        {
            Directory.Move(staging, installDirectory);
            TryDeleteDirectory(backup);
        }
        catch
        {
            if (!Directory.Exists(installDirectory) && Directory.Exists(backup))
            {
                Directory.Move(backup, installDirectory);
            }
            throw;
        }
    }

    private static void CreateDesktopShortcut(string installDirectory)
    {
        var shortcutPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
            "OBS Karaoke MVP.lnk");
        var shellType = Type.GetTypeFromProgID("WScript.Shell")
            ?? throw new InvalidOperationException("Windows 바로가기 기능을 사용할 수 없습니다.");
        object? shell = null;
        object? shortcut = null;
        try
        {
            shell = Activator.CreateInstance(shellType);
            dynamic dynamicShell = shell!;
            shortcut = dynamicShell.CreateShortcut(shortcutPath);
            dynamic dynamicShortcut = shortcut;
            dynamicShortcut.TargetPath = Path.Combine(installDirectory, "OBS Karaoke MVP.exe");
            dynamicShortcut.WorkingDirectory = installDirectory;
            dynamicShortcut.Description = "OBS Karaoke MVP";
            dynamicShortcut.Save();
        }
        finally
        {
            if (shortcut is not null && Marshal.IsComObject(shortcut))
                Marshal.FinalReleaseComObject(shortcut);
            if (shell is not null && Marshal.IsComObject(shell))
                Marshal.FinalReleaseComObject(shell);
        }
    }

    private static void TryDeleteDirectory(string path)
    {
        try
        {
            if (Directory.Exists(path)) Directory.Delete(path, recursive: true);
        }
        catch
        {
            // A failed cleanup must not hide the original install result.
        }
    }
}

public sealed class ReleaseManifest
{
    public string Version { get; set; } = "";
    public string InstallerSha256 { get; set; } = "";
    public List<ReleaseAsset> Assets { get; set; } = [];
}

public sealed class ReleaseAsset
{
    public string Name { get; set; } = "";
    public string Sha256 { get; set; } = "";
    public long Size { get; set; }
}
