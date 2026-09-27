/* =====================================================================
   Adds a per-terminal / per-print-area PrintAgentUrl override.

   Server-initiated prints (Admin Test Print, X-Read, Z-Read, Blind Close, Send to
   Kitchen) are dialed BY THE SERVER, not the terminal's own browser — so
   PrintAgent:BaseUrl in appsettings.json (typically localhost, meaning "wherever the
   API server itself runs") only works when a terminal's printer/agent happens to sit
   on that same machine. Any terminal or print area whose printer is attached to a
   DIFFERENT machine (the normal case once you have more than one physical terminal)
   needs its own agent address here. NULL keeps using the server's own default.
   Safe to run more than once.
   Run: sqlcmd -S <server> -U sa -P <pwd> -d TabletPOS -i 13_print_agent_url.sql
   ===================================================================== */
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Terminals') AND name = 'PrintAgentUrl')
BEGIN
    ALTER TABLE dbo.Terminals ADD PrintAgentUrl NVARCHAR(200) NULL;
END
GO

IF OBJECT_ID('dbo.PrintAreas', 'U') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.PrintAreas') AND name = 'PrintAgentUrl')
BEGIN
    ALTER TABLE dbo.PrintAreas ADD PrintAgentUrl NVARCHAR(200) NULL;
END
GO
