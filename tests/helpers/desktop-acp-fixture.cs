using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// A private agy.exe for the packaged Windows test. It forwards only ACP to the local Node fixture.
class DesktopAcpFixture {
    static void Pump(Stream input, Stream output) {
        byte[] buffer = new byte[8192];
        int count;
        while ((count = input.Read(buffer, 0, buffer.Length)) > 0) {
            output.Write(buffer, 0, count);
            output.Flush();
        }
    }

    static void WriteProfileResponses(Stream source, Stream destination, string profileId) {
        var json = new JavaScriptSerializer();
        var utf8 = new UTF8Encoding(false);
        using (var reader = new StreamReader(source, utf8))
        using (var writer = new StreamWriter(destination, utf8) { AutoFlush = true }) {
            string line;
            while ((line = reader.ReadLine()) != null) {
                var message = json.Deserialize<Dictionary<string, object>>(line);
                object value;
                var result = message.TryGetValue("result", out value) ? value as Dictionary<string, object> : null;
                if (result != null && result.ContainsKey("models")) {
                    string standard = "qa-" + profileId;
                    result["models"] = new { currentModelId = standard, availableModels = new[] {
                        new { modelId = standard, name = "Standard " + profileId },
                        new { modelId = standard + "-fast", name = "Fast " + profileId }
                    } };
                    line = json.Serialize(message);
                }
                writer.WriteLine(line);
            }
        }
    }

    static int Main(string[] args) {
        if (args.Length == 2 && args[0] == "--settings") {
            string result = Environment.GetEnvironmentVariable("GRAVITY_QUOTA_RESULT");
            if (String.IsNullOrEmpty(result)) return 2;
            File.WriteAllText(result, "{\"quota\":{\"gemini-weekly\":{\"remaining_fraction\":0.5}}}");
            return 0;
        }
        if (args.Length == 0 || args[0] != "acp") return 2;
        string profileId = null;
        if (args.Length != 1) {
            if (args.Length != 3 || args[1] != "--app-data-dir") return 2;
            string root = Environment.GetEnvironmentVariable("GRAVITY_QA_PROFILES_DIR");
            if (String.IsNullOrEmpty(root)) return 2;
            string dir = Path.GetFullPath(args[2]);
            profileId = Path.GetFileName(dir);
            Guid id;
            if (!String.Equals(Path.GetDirectoryName(dir), Path.GetFullPath(root), StringComparison.OrdinalIgnoreCase)
                || !profileId.StartsWith("profile-", StringComparison.Ordinal)
                || !Guid.TryParseExact(profileId.Substring("profile-".Length), "D", out id)) return 2;
        }
        string script = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "mock-acp.cjs");
        var info = new ProcessStartInfo(Environment.GetEnvironmentVariable("GRAVITY_QA_NODE"), "\"" + script + "\"") {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true,
        };
        using (var child = Process.Start(info)) {
            var writer = new Thread(() => {
                try { Pump(Console.OpenStandardInput(), child.StandardInput.BaseStream); }
                catch (IOException) {}
                finally { try { child.StandardInput.Close(); } catch (IOException) {} }
            });
            writer.IsBackground = true;
            writer.Start();
            if (profileId == null) Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput());
            else WriteProfileResponses(child.StandardOutput.BaseStream, Console.OpenStandardOutput(), profileId);
            child.WaitForExit();
            return child.ExitCode;
        }
    }
}
