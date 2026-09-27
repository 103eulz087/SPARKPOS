namespace PosApi.Models;

public record LoginRequest(string Username, string Password, string BranchCode);

public record OpenShiftRequest(Guid ShiftUid, string BranchCode, int TerminalId,
    DateTime BusinessDate, decimal CashBegin, DateTime OpenedAt);

public record BlindCloseRequest(Guid ShiftUid, Dictionary<string, int> Denominations);

/// Admin/Supervisor recovery for a shift the original cashier never blind-closed
/// (lost device, forgot, terminal reset). The count entered here plays the same
/// role the cashier's own blind close would have.
public record ForceBlindCloseRequest(Dictionary<string, int> Denominations, string Remark);

public record SaleItemDto(int LineNo, int ProductId, string Barcode, string ProductName,
    int CategoryId, decimal Quantity, decimal UnitPrice, decimal OrigUnitPrice,
    decimal LineDiscount, decimal LineTotal, bool IsVatable, bool IsDiscountable);

public record SalePaymentDto(int SeqNo, string PaymentType, decimal Amount,
    string? CardNo, string? CardBank, string? CardRefNo, string? CardName);

/// VatAdjustment is reporting-only (VAT forgone on lines discounted but still VATable —
/// see CLAUDE.md's discount-configuration notes), never a further cash deduction.
/// DinerCount/SeniorCount are Restaurant PosType only, captured at Generate Bill.
public record SaleDto(Guid SaleUid, Guid ShiftUid, string BranchCode, int TerminalId,
    long ORNumber, DateTime BusinessDate, DateTime SaleDateTime,
    decimal GrossAmount, decimal DiscountAmount, decimal VatExemptAmount, decimal VatableAmount,
    decimal VatAmount, decimal ZeroRatedAmount, decimal NetAmount, decimal TenderedAmount,
    decimal ChangeAmount, string? DiscountCode, string? DiscountCtrlNo, string? DiscountName,
    decimal VatAdjustment, int? DinerCount, int? SeniorCount,
    string Status, List<SaleItemDto> Items, List<SalePaymentDto> Payments);

public record SyncBatchRequest(List<SaleDto> Sales);

/// Per-category override of a discount type's rate/VAT treatment (RA 9994 etc. — e.g.
/// Senior Citizen is 20%+VAT-exempt on medicine but only 5%+still-VATable on groceries).
/// No row for a category means "use the discount type's own default Rate/IsVatExempt".
public record DiscountCategoryRateDto(string DiscountCode, int CategoryId, decimal Rate, bool IsVatExempt);

public record VoidRequest(Guid SaleUid, string Reason,
    string? OverrideUsername, string? OverridePassword);

/// ApproverUsername/Password are only required when the branch's EodOverride
/// setting is on and the signed-in user isn't already Admin/Supervisor.
public record EndOfDayRequest(int TerminalId, DateTime BusinessDate,
    string? ApproverUsername, string? ApproverPassword, string? Remarks);

public record ProductDto(int ProductId, string Barcode, string ProductName, int CategoryId,
    string Unit, decimal BasePrice, decimal Cost, bool IsVatable, bool IsDiscountable,
    bool AllowPriceEdit, bool IsActive, string? ImageUrl = null);

public record BranchPriceDto(string BranchCode, decimal Price);
public record SaveProductPricesRequest(List<BranchPriceDto> Prices);

public record BulkPriceRequest(string? BranchCode, int? CategoryId, string Mode, decimal Value);
public record CopyPricesRequest(string FromBranch, string ToBranch);

public record BranchDto(string BranchCode, string BranchName, string? Tin,
    string? BirBranchCode, string? Address, string? ContactNo, bool IsActive);

/// PaperWidth is in mm — 58 (32 columns) or 80 (48 columns); see ReceiptBuilder.Columns().
/// PrintAgentKey routes server-initiated prints (Test Print, X-Read, Z-Read, Blind Close) to
/// the right polling PrintAgent (see PrintJobsController) — null/blank uses the shared
/// default agent (a single-agent setup needs no configuration at all).
public record TerminalDto(int TerminalId, string BranchCode, string TerminalCode,
    string TerminalName, string? PrinterTarget, int PaperWidth, string? PrintAgentKey,
    string? Tin, string? AccreditationNo,
    string? SerialNo, string? PermitNo, string? MinNo, DateTime? PermitEffective, bool IsActive);

/// Dine-in tables (PosSettings.PosType = 'Restaurant' only).
public record TableDto(int TableId, string BranchCode, string TableNumber, int Capacity, bool IsActive);

public record OpenTableRequest(int TableId, int TerminalId, Guid ShiftUid);

public record AddOrderItemRequest(int ProductId, string Barcode, string ProductName, int CategoryId,
    decimal Quantity, decimal UnitPrice, bool IsVatable, bool IsDiscountable);

public record SetOrderItemQtyRequest(decimal Quantity);

/// Sent by the client right after its normal checkout flow (completeSale) succeeds for a
/// dine-in order, so the tab can be marked billed and the table freed.
public record CloseOrderRequest(Guid SaleUid);

/// Local-first dine-in sync (mirrors SyncBatchRequest for sales). Each order carries its
/// full current item list — the server replaces the order's items wholesale rather than
/// replaying individual add/remove calls.
public record SyncOrderItemDto(int LineNo, int ProductId, string Barcode, string ProductName,
    int CategoryId, decimal Quantity, decimal UnitPrice, bool IsVatable, bool IsDiscountable);

public record SyncOrderDto(Guid OpenOrderUid, int TableId, string BranchCode, int TerminalId,
    Guid ShiftUid, int OpenedByUserId, DateTime OpenedAt, string Status, DateTime? ClosedAt,
    Guid? SaleUid, List<SyncOrderItemDto> Items);

public record SyncOrdersRequest(List<SyncOrderDto> Orders);

/// Kitchen/beverage print stations (Restaurant PosType). Each has its own network
/// printer target, per branch. PrintAgentKey: see TerminalDto's note.
public record PrintAreaDto(int AreaId, string BranchCode, string AreaName, string PrinterTarget,
    int PaperWidth, string? PrintAgentKey, bool IsActive);

/// Categories are global; which print area a category routes to is per-branch.
/// AreaId = null clears the mapping (that category won't be sent to any printer).
public record SetCategoryPrintAreaRequest(string BranchCode, int? AreaId);

/// "Send to Kitchen" — the client sends the order's current full item snapshot; the
/// server compares against each line's already-recorded SentQuantity to print only
/// what's new, then updates SentQuantity to match.
public record SendToKitchenItemDto(int LineNo, int ProductId, string Barcode, string ProductName,
    int CategoryId, decimal Quantity, decimal UnitPrice, bool IsVatable, bool IsDiscountable);

public record SendToKitchenRequest(string TableNumber, List<SendToKitchenItemDto> Items);

public record UserDto(int UserId, string Username, string? Password, string FullName,
    string Role, bool IsActive, List<string>? Branches);

/// SmtpPassword is null/blank on save to mean "keep the existing password" — mirrors the
/// user password-reset pattern. Never returned to the browser after being set.
public record EmailConfigDto(string SmtpHost, int SmtpPort, string SmtpUser, string? SmtpPassword,
    string FromAddress, string ToAddresses, bool EnableSsl, bool SendOnEod, bool IsActive);

public record PosSettingsDto(string BranchCode, string PosType, bool VoidOverride,
    bool PriceEditOverride, bool ReprintOverride, bool EodOverride, bool EmailOnBlindClose,
    bool RefundEnabled, bool BlockLoginAfterEod, int OrBlockSize, int OrLowWarning,
    decimal MaxDiscountPerTxn, string? StoreHeader1, string? StoreHeader2, string? ReceiptFooter);
