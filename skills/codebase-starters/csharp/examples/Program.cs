using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace App.WebApi;

public record UserDto(string UserId, string Email, double Score, bool IsActive);

public sealed record ProcessedResult(string UserId, string Status, double AdjustedScore);

public interface IProcessorService
{
    Task<ProcessedResult> ProcessAsync(UserDto user, CancellationToken ct = default);
}

public sealed class CoreProcessorService : IProcessorService
{
    private readonly string _engineName;

    public CoreProcessorService(string engineName)
    {
        _engineName = engineName ?? throw new ArgumentNullException(nameof(engineName));
    }

    public async Task<ProcessedResult> ProcessAsync(UserDto user, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(user);
        
        await Task.Delay(50, ct); // Simulated async work

        double adjusted = user.Score * 1.15;
        return new ProcessedResult(
            UserId: user.UserId,
            Status: $"ProcessedBy_{_engineName}",
            AdjustedScore: Math.Round(adjusted, 2)
        );
    }
}

public static class Program
{
    public static async Task Main(string[] args)
    {
        Console.WriteLine("=== .NET 8 / C# 12 Production Starter ===");
        
        IProcessorService service = new CoreProcessorService("DotNetCoreEngine");
        var user = new UserDto("usr_8820", "csharp.dev@example.com", 150.0, true);

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var result = await service.ProcessAsync(user, cts.Token);

        string jsonOutput = JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = true });
        Console.WriteLine($"Output:\n{jsonOutput}");
    }
}
