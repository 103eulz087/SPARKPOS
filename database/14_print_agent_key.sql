/* =====================================================================
   Adds a per-terminal / per-print-area PrintAgentKey — required once that agent is
   reachable beyond the local network (e.g. via router port-forwarding to a remote
   server), since PrintAgent's /print endpoint otherwise has no authentication at all
   and would accept a print job from anyone who can reach the exposed port. Must match
   the ApiKey configured in that agent's own appsettings.json (or PRINTAGENT_APIKEY env
   var), sent as the X-Agent-Key header. NULL/blank = no auth required (fine for a
   same-LAN-only agent that was never exposed to begin with).
   Safe to run more than once.
   Run: sqlcmd -S <server> -U sa -P <pwd> -d TabletPOS -i 14_print_agent_key.sql
   ===================================================================== */
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Terminals') AND name = 'PrintAgentKey')
BEGIN
    ALTER TABLE dbo.Terminals ADD PrintAgentKey NVARCHAR(100) NULL;
END
GO

IF OBJECT_ID('dbo.PrintAreas', 'U') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.PrintAreas') AND name = 'PrintAgentKey')
BEGIN
    ALTER TABLE dbo.PrintAreas ADD PrintAgentKey NVARCHAR(100) NULL;
END
GO
