/* =====================================================================
   Replaces direct-push printing (PrintAgentUrl) with a poll-based job queue.

   Server-initiated prints (Test Print, X-Read, Z-Read, Blind Close, Send to Kitchen)
   used to have the SERVER call directly into a PrintAgent's HTTP endpoint —
   requiring that agent to be reachable FROM the server, which meant router
   port-forwarding (and the security exposure that comes with it) for any terminal
   not on the same network as the server. This flips the direction: PrintAgent now
   POLLS the server for pending jobs instead, which is a purely outbound connection
   and needs zero network configuration regardless of where the terminal physically is.

   dbo.PrintJobs is the queue. PrintAgentUrl is dropped from both Terminals and
   PrintAreas — it's no longer used for anything. PrintAgentKey stays; it's now the
   agent's own polling identity instead of a push destination credential.
   Safe to run more than once.
   Run: sqlcmd -S <server> -U sa -P <pwd> -d TabletPOS -i 15_print_jobs_queue.sql
   ===================================================================== */
IF OBJECT_ID('dbo.PrintJobs', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.PrintJobs (
        PrintJobId      BIGINT IDENTITY(1,1) PRIMARY KEY,
        AgentKey        NVARCHAR(100) NOT NULL DEFAULT '',
        PrinterTarget   NVARCHAR(200) NULL,
        JobText         NVARCHAR(MAX) NOT NULL,
        Status          VARCHAR(12) NOT NULL DEFAULT 'Pending' CHECK (Status IN ('Pending','Delivered')),
        CreatedAt       DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
        DeliveredAt     DATETIME2 NULL
    );
    CREATE INDEX IX_PrintJobs_Agent_Status ON dbo.PrintJobs(AgentKey, Status, PrintJobId);
END
GO

IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Terminals') AND name = 'PrintAgentUrl')
BEGIN
    ALTER TABLE dbo.Terminals DROP COLUMN PrintAgentUrl;
END
GO

IF OBJECT_ID('dbo.PrintAreas', 'U') IS NOT NULL
   AND EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.PrintAreas') AND name = 'PrintAgentUrl')
BEGIN
    ALTER TABLE dbo.PrintAreas DROP COLUMN PrintAgentUrl;
END
GO
