/* =====================================================================
   40 — Price level by time of day (2026-11-20)
   The user: the default is the regular price (SellingPrice), and at e.g. 7 PM the till switches to
   Price 1 by itself. Their calls: per branch and per terminal (the GRILLS tills have their own; one
   schedule can also cover every branch), a start and an
   end time on chosen days, a sale already being rung up keeps its prices (the next sale switches),
   and the cashier can still put a sale back to the regular price.
   - dbo.PriceLevelSchedules: BranchCode (NULL = every branch), TerminalId (NULL = the branch's;
     set = that till only, BranchCode its branch), PriceLevel 1-4, StartTime, EndTime
     (an end before the start runs past midnight, e.g. 22:00-02:00), Days (7 characters, Monday
     first, 'Y' or 'N'), IsActive.
   A till uses its own schedules if it has any, else its branch's, else the every-branch ones. The till
   gets them with its POS screen and applies them by its own clock (offline too).
   Idempotent. Run, then re-run 02_procedures.sql (no proc changes).
   ===================================================================== */
SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID('dbo.PriceLevelSchedules', 'U') IS NULL
    CREATE TABLE dbo.PriceLevelSchedules (
        ScheduleId  INT IDENTITY(1,1) PRIMARY KEY,
        BranchCode  VARCHAR(10) NULL,
        TerminalId  INT NULL,
        PriceLevel  TINYINT NOT NULL CONSTRAINT CK_PriceLevelSchedules_Level CHECK (PriceLevel BETWEEN 1 AND 4),
        StartTime   TIME(0) NOT NULL,
        EndTime     TIME(0) NOT NULL,
        Days        CHAR(7) NOT NULL CONSTRAINT DF_PriceLevelSchedules_Days DEFAULT 'YYYYYYY'
                    CONSTRAINT CK_PriceLevelSchedules_Days CHECK (Days NOT LIKE '%[^YN]%' AND Days LIKE '%Y%'),
        IsActive    BIT NOT NULL CONSTRAINT DF_PriceLevelSchedules_IsActive DEFAULT 1,
        Note        NVARCHAR(100) NULL,
        UpdatedAt   DATETIME2 NOT NULL CONSTRAINT DF_PriceLevelSchedules_UpdatedAt DEFAULT SYSDATETIME(),
        UpdatedBy   INT NULL,
        CONSTRAINT CK_PriceLevelSchedules_Times CHECK (StartTime <> EndTime)
    );
GO
-- (the first copy of 40, on TabletPOS only, had no TerminalId)
IF COL_LENGTH('dbo.PriceLevelSchedules', 'TerminalId') IS NULL
    ALTER TABLE dbo.PriceLevelSchedules ADD TerminalId INT NULL;
GO
