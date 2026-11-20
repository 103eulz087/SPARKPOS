/* =====================================================================
   23 — Posting to the CORECS ERP, step 4.2: shifts, returns, Z-Read (2026-10-27)
   The ERP now needs each shift opened before its sales (spu_SparkPOS_OpenShift), takes
   returns (spu_SparkPOS_PostReturn), shift closes (spu_SparkPOS_CloseShift) and the day's
   Z-Read (spu_SparkPOS_PostZRead). They go through the same dbo.ErpOutbox, in order per
   terminal. Idempotent. Run this, then re-run 02_procedures.sql.
   ===================================================================== */
SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON;
GO

/* Outbox kinds: replace the original unnamed CHECK with a named one listing them all. */
DECLARE @ck SYSNAME = (SELECT TOP 1 cc.name FROM sys.check_constraints cc
                       WHERE cc.parent_object_id = OBJECT_ID('dbo.ErpOutbox') AND cc.definition LIKE '%SALE%'
                         AND cc.name <> 'CK_ErpOutbox_Kind');
IF @ck IS NOT NULL EXEC('ALTER TABLE dbo.ErpOutbox DROP CONSTRAINT ' + @ck);
GO
IF OBJECT_ID('dbo.CK_ErpOutbox_Kind', 'C') IS NULL
    ALTER TABLE dbo.ErpOutbox ADD CONSTRAINT CK_ErpOutbox_Kind
        CHECK (Kind IN ('OPEN', 'SALE', 'VOID', 'RETURN', 'CLOSE', 'ZREAD'));
GO

/* The ERP keys a Z-Read by a GUID. */
IF COL_LENGTH('dbo.ZReads', 'ZReadUid') IS NULL
    ALTER TABLE dbo.ZReads ADD ZReadUid UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_ZReads_ZReadUid DEFAULT NEWID();
GO
