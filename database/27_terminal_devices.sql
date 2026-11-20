/* =====================================================================
   27 — Each till device assigned to its own terminal (2026-11-13)
   At a branch with several POS PCs (VROSS V1 has 5), a cashier used to pick any terminal at
   Cash Begin. A supervisor now assigns each device once ("this PC is POS-01"): the device
   keeps a random token in its browser, and only the token's SHA-256 is stored here.
   - A device with an assigned terminal sees only that terminal at Cash Begin.
   - An assigned terminal is hidden from every other device, and opening a shift on it from
     another device is refused (ShiftsController.Open).
   - A terminal with no row here works as before, from any device.
   One device per terminal and one terminal per device: assigning again replaces the row.
   Idempotent. No procedure changes.
   ===================================================================== */
SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID('dbo.TerminalDevices', 'U') IS NULL
CREATE TABLE dbo.TerminalDevices (
    TerminalId      INT NOT NULL CONSTRAINT PK_TerminalDevices PRIMARY KEY
                    CONSTRAINT FK_TerminalDevices_Terminal REFERENCES dbo.Terminals (TerminalId),
    TokenHash       VARBINARY(32) NOT NULL CONSTRAINT UQ_TerminalDevices_Token UNIQUE,
    DeviceLabel     NVARCHAR(100) NULL,     -- what the browser says it is, for Admin's list
    AssignedAt      DATETIME2 NOT NULL CONSTRAINT DF_TerminalDevices_AssignedAt DEFAULT SYSDATETIME(),
    AssignedBy      INT NULL
);
GO
