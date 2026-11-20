using System.Text.Json;
using System.Text.Json.Serialization;

namespace PosApi.Services;

/// SparkPOS keeps every date and time in Philippine local time (Asia/Manila): business dates,
/// sale/shift/return times, Z-Reads — that's what BIR reports and the ERP expect. Browsers send
/// times as UTC (toISOString(), ending in "Z"); stored as is, a sale at 11:20 PM was saved as
/// 3:20 PM, and anything before 8 AM fell on the previous day.
public static class LocalTime
{
    public static readonly TimeZoneInfo Zone = Resolve();

    private static TimeZoneInfo Resolve()
    {
        foreach (var id in new[] { "Asia/Manila", "Singapore Standard Time" })   // IANA, then Windows
            try { return TimeZoneInfo.FindSystemTimeZoneById(id); } catch { /* try the next */ }
        return TimeZoneInfo.Local;
    }

    public static DateTime FromUtc(DateTime utc) =>
        DateTime.SpecifyKind(TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(utc, DateTimeKind.Utc), Zone),
            DateTimeKind.Unspecified);
}

/// Every DateTime in a request is turned into Philippine local time before a controller sees
/// it; a date-only value ("2026-10-26") or one without a zone is taken as already local.
/// Responses go out without a zone, so browsers read them as local time, as before.
public class LocalDateTimeConverter : JsonConverter<DateTime>
{
    public override DateTime Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        var dt = reader.GetDateTime();
        return dt.Kind switch
        {
            DateTimeKind.Utc => LocalTime.FromUtc(dt),
            DateTimeKind.Local => LocalTime.FromUtc(dt.ToUniversalTime()),
            _ => dt
        };
    }

    public override void Write(Utf8JsonWriter writer, DateTime value, JsonSerializerOptions options) =>
        writer.WriteStringValue((value.Kind == DateTimeKind.Utc ? LocalTime.FromUtc(value) : value)
            .ToString("yyyy-MM-dd'T'HH:mm:ss.FFFFFFF"));
}
