using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using ObsKaraokeLauncher;
using ObsKaraokeSetup;

var root = Path.Combine(Path.GetTempPath(), $"obs-update-check-{Guid.NewGuid():N}");
Directory.CreateDirectory(root);
try
{
    var bytes = "mock installer bytes"u8.ToArray();
    var installerHash = Convert.ToHexString(SHA256.HashData(bytes));
    static string Manifest(string core, string setup) => JsonSerializer.Serialize(new
    {
        version = "0.1.0-alpha", installerSha256 = setup,
        assets = new[] { new { name = "obs-karaoke-app-core-win-x64.zip", sha256 = core } }
    });
    var oldHash = new string('A', 64);
    var newHash = new string('B', 64);
    var receipt = Path.Combine(root, "release-manifest.json");
    await File.WriteAllTextAsync(receipt, Manifest(oldHash, installerHash));
    var manifestUri = new Uri("https://example.test/release-manifest.json");
    var installerUri = new Uri("https://example.test/OBS-Karaoke-Setup.exe");
    using var handler = new ResponseHandler(uri => uri == manifestUri
        ? System.Text.Encoding.UTF8.GetBytes(Manifest(newHash, installerHash)) : bytes);
    using var client = new HttpClient(handler);
    var update = await UpdateChecker.CheckAsync(receipt, manifestUri, installerUri, client, CancellationToken.None);
    Check(update is not null && update.InstallerSha256 == installerHash, "new core detected");
    Check(await UpdateChecker.CheckAsync(Path.Combine(root, "missing.json"), manifestUri,
        installerUri, client, CancellationToken.None) is null, "portable build without receipt skips check");

    var target = Path.Combine(root, "setup", "OBS-Karaoke-Setup.exe");
    await UpdateChecker.DownloadInstallerAsync(update!, target, client, CancellationToken.None);
    Check((await File.ReadAllBytesAsync(target)).SequenceEqual(bytes), "download verified");
    await File.WriteAllTextAsync(receipt, Manifest(newHash, installerHash));
    Check(await UpdateChecker.CheckAsync(receipt, manifestUri, installerUri,
        client, CancellationToken.None) is null, "same build does not prompt again");

    var bad = update! with { InstallerSha256 = new string('C', 64) };
    try
    {
        await UpdateChecker.DownloadInstallerAsync(bad, target, client, CancellationToken.None);
        throw new Exception("Corrupt installer was accepted.");
    }
    catch (InvalidDataException) { Check(!File.Exists(target), "bad download removed"); }

    var source = Path.Combine(root, "installed", "models");
    Directory.CreateDirectory(source);
    await File.WriteAllTextAsync(Path.Combine(source, "model.bin"), "local model");
    Check(LocalAssetReuse.CanReuse(source, newHash, newHash), "unchanged model reusable");
    Check(!LocalAssetReuse.CanReuse(source, oldHash, newHash), "changed model redownloaded");
    var copied = Path.Combine(root, "staging", "models");
    LocalAssetReuse.CopyTree(source, copied, CancellationToken.None);
    Directory.Delete(source, recursive: true);
    Check(await File.ReadAllTextAsync(Path.Combine(copied, "model.bin")) == "local model",
        "staged model survives removal of old installation");
    Console.WriteLine("Update checks, installer hash and local runtime reuse passed.");
}
finally
{
    Directory.Delete(root, recursive: true);
}

static void Check(bool condition, string name)
{
    if (!condition) throw new Exception($"Failed: {name}");
}

internal sealed class ResponseHandler(Func<Uri, byte[]> respond) : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) =>
        Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new ByteArrayContent(respond(request.RequestUri!))
        });
}
