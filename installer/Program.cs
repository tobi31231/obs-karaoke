using System.Diagnostics;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;

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
        Application.Run(new InstallerForm());
    }
}

public sealed class InstallerForm : Form
{
    private const string RemoteManifestUrl =
        "https://github.com/tobi31231/obs-karaoke/releases/latest/download/release-manifest.json";
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromHours(2) };
    private static readonly string InstallDirectory =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OBS Karaoke MVP");

    private readonly Label _status = new();
    private readonly ProgressBar _progress = new();
    private readonly Button _install = new();
    private readonly Button _cancel = new();
    private CancellationTokenSource? _cancellation;

    public InstallerForm()
    {
        Text = "OBS Karaoke MVP 설치";
        Width = 560;
        Height = 260;
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;

        var title = new Label
        {
            Text = "OBS Karaoke MVP",
            Font = new Font(Font.FontFamily, 17, FontStyle.Bold),
            AutoSize = true,
            Location = new Point(24, 22)
        };
        var description = new Label
        {
            Text = "Turbo 모델과 로컬 실행 환경을 설치합니다.",
            AutoSize = true,
            Location = new Point(27, 61)
        };
        _status.Text = $"설치 위치: {InstallDirectory}";
        _status.AutoEllipsis = true;
        _status.Location = new Point(27, 96);
        _status.Size = new Size(500, 38);
        _progress.Location = new Point(27, 139);
        _progress.Size = new Size(500, 22);
        _install.Text = "설치";
        _install.Location = new Point(339, 177);
        _install.Size = new Size(90, 32);
        _install.Click += async (_, _) => await InstallAsync();
        _cancel.Text = "닫기";
        _cancel.Location = new Point(437, 177);
        _cancel.Size = new Size(90, 32);
        _cancel.Click += (_, _) =>
        {
            if (_cancellation is null) Close();
            else _cancellation.Cancel();
        };

        Controls.AddRange([title, description, _status, _progress, _install, _cancel]);
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
        _cancellation = new CancellationTokenSource();
        _install.Enabled = false;
        _cancel.Text = "취소";
        _progress.Style = ProgressBarStyle.Marquee;

        var staging = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            $"OBS Karaoke MVP.installing-{Guid.NewGuid():N}");
        var downloadDirectory = Path.Combine(Path.GetTempPath(), $"obs-karaoke-setup-{Guid.NewGuid():N}");

        try
        {
            Directory.CreateDirectory(staging);
            Directory.CreateDirectory(downloadDirectory);
            var (manifest, manifestUri) = await LoadManifestAsync(_cancellation.Token);

            foreach (var asset in manifest.Assets)
            {
                _cancellation.Token.ThrowIfCancellationRequested();
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

            _status.Text = "설치 마무리 중...";
            InstallStagingDirectory(staging);
            CreateDesktopShortcut();
            _progress.Style = ProgressBarStyle.Continuous;
            _progress.Value = 100;
            _status.Text = $"설치 완료: {manifest.Version}";
            _cancel.Text = "닫기";
            _cancellation.Dispose();
            _cancellation = null;

            Process.Start(new ProcessStartInfo
            {
                FileName = Path.Combine(InstallDirectory, "OBS Karaoke MVP.exe"),
                WorkingDirectory = InstallDirectory,
                UseShellExecute = true
            });
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
            TryDeleteDirectory(staging);
            TryDeleteDirectory(downloadDirectory);
            _cancellation?.Dispose();
            _cancellation = null;
            _install.Enabled = true;
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
        return (DeserializeManifest(content), response.RequestMessage?.RequestUri ?? new Uri(RemoteManifestUrl));
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

    private static void InstallStagingDirectory(string staging)
    {
        var backup = InstallDirectory + ".old";
        TryDeleteDirectory(backup);
        if (Directory.Exists(InstallDirectory))
        {
            Directory.Move(InstallDirectory, backup);
        }

        try
        {
            Directory.Move(staging, InstallDirectory);
            TryDeleteDirectory(backup);
        }
        catch
        {
            if (!Directory.Exists(InstallDirectory) && Directory.Exists(backup))
            {
                Directory.Move(backup, InstallDirectory);
            }
            throw;
        }
    }

    private static void CreateDesktopShortcut()
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
            dynamicShortcut.TargetPath = Path.Combine(InstallDirectory, "OBS Karaoke MVP.exe");
            dynamicShortcut.WorkingDirectory = InstallDirectory;
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
    public List<ReleaseAsset> Assets { get; set; } = [];
}

public sealed class ReleaseAsset
{
    public string Name { get; set; } = "";
    public string Sha256 { get; set; } = "";
    public long Size { get; set; }
}
