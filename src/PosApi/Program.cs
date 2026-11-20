using System.Text;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.IdentityModel.Tokens;
using PosApi.Services;

var builder = WebApplication.CreateBuilder(args);

// Dates in requests become Philippine local time (Services/LocalTime.cs).
builder.Services.AddControllers()
    .AddJsonOptions(o => o.JsonSerializerOptions.Converters.Add(new LocalDateTimeConverter()));
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();
builder.Services.AddHttpClient();
builder.Services.AddSingleton<Db>();
builder.Services.AddSingleton<ErpDb>();
builder.Services.AddSingleton<ErpSyncService>();
builder.Services.AddHostedService<ErpAutoSync>();   // Erp:AutoSyncMinutes (0 = off)
builder.Services.AddSingleton<ErpPostingService>();
builder.Services.AddHostedService<ErpPostingWorker>();   // Erp:PostIntervalSeconds (0 = off)
builder.Services.AddSingleton<TokenService>();
builder.Services.AddSingleton<ReceiptBuilder>();
builder.Services.AddSingleton<PrintService>();
builder.Services.AddSingleton<EmailService>();
builder.Services.AddSingleton<InvoiceEmailService>();
builder.Services.AddHostedService<InvoiceEmailWorker>();   // Email:InvoiceIntervalSeconds (0 = off)

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(o => o.TokenValidationParameters = new TokenValidationParameters
    {
        ValidateIssuer = true,
        ValidIssuer = builder.Configuration["Jwt:Issuer"],
        ValidateAudience = false,
        ValidateIssuerSigningKey = true,
        IssuerSigningKey = new SymmetricSecurityKey(
            Encoding.UTF8.GetBytes(builder.Configuration["Jwt:Key"]!)),
        ClockSkew = TimeSpan.FromMinutes(2)
    });
builder.Services.AddAuthorization();

builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod()));

var app = builder.Build();

// Wait for SQL, then fix seed password hashes
await DbBootstrap.RunAsync(app.Services.GetRequiredService<Db>(), app.Logger);

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

app.UseCors();
app.UseDefaultFiles();
// The service worker (sw.js, built by web/vite.config.js) and index.html must always be checked
// with the server, or a device keeps running an old version; the hashed /assets files may cache.
var staticFiles = new StaticFileOptions
{
    OnPrepareResponse = c =>
    {
        var name = c.File.Name;
        if (name is "sw.js" or "index.html" or "manifest.webmanifest" || name.StartsWith("workbox-"))
            c.Context.Response.Headers.CacheControl = "no-cache";
    }
};
app.UseStaticFiles(staticFiles);
app.UseAuthentication();
app.UseAuthorization();
app.MapControllers();
app.MapGet("/health", () => Results.Ok(new { status = "ok", utc = DateTime.UtcNow }));
// An /api address with no controller is a 404, not the SPA's index.html: a web app newer than
// the server then gets a clear answer instead of a page it tries to read as data.
app.Map("/api/{**rest}", () => Results.NotFound(new { message = "This server doesn't have that feature: it runs an older version than the screen. Update the server." }));
app.MapFallbackToFile("index.html", staticFiles);

app.Run();
