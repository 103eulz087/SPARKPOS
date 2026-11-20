namespace PosApi.Models;

/// BranchCode is optional: left out, the user's own assigned branch is used (see AuthController.Login).
public record LoginRequest(string Username, string Password, string? BranchCode = null);

public record OpenShiftRequest(Guid ShiftUid, string BranchCode, int TerminalId,
    DateTime BusinessDate, decimal CashBegin, DateTime OpenedAt);

public record BlindCloseRequest(Guid ShiftUid, Dictionary<string, int> Denominations);

/// 39: the drawer was opened with no sale. DrawerOpenUid is the till's own id (sent again offline,
/// it's kept once); ApprovedBy is the supervisor when the till asked for one; Method KICK / SLIP.
public record DrawerOpenRequest(Guid DrawerOpenUid, string Reason, string? Note, int? ApprovedBy,
    DateTime OpenedAt, string? Method);

/// Admin/Supervisor recovery for a shift the original cashier never blind-closed
/// (lost device, forgot, terminal reset). The count entered here plays the same
/// role the cashier's own blind close would have.
public record ForceBlindCloseRequest(Dictionary<string, int> Denominations, string Remark);

/// NetAmount..VatAdjustment: this line's share of the BIR figures, as computeTotals()
/// (web/src/lib/store.js) worked them out. A return refunds from these.
public record SaleItemDto(int LineNo, int ProductId, string Barcode, string ProductName,
    int CategoryId, decimal Quantity, decimal UnitPrice, decimal OrigUnitPrice,
    decimal LineDiscount, decimal LineTotal, bool IsVatable, bool IsDiscountable,
    decimal NetAmount = 0, decimal VatableAmount = 0, decimal VatAmount = 0,
    decimal VatExemptAmount = 0, decimal ZeroRatedAmount = 0, decimal VatAdjustment = 0,
    int? PriceApprovedBy = null);

public record SalePaymentDto(int SeqNo, string PaymentType, decimal Amount,
    string? CardNo, string? CardBank, string? CardRefNo, string? CardName,
    string? GcNo = null, decimal? GcValue = null);   // 38: a gift certificate's number and face value

/// VatAdjustment is reporting-only (VAT forgone on lines discounted but still VATable —
/// see CLAUDE.md's discount-configuration notes), never a further cash deduction.
/// DinerCount/SeniorCount are Restaurant PosType only, captured at Generate Bill.
/// DiscountApprovedBy: the supervisor of a regular/other discount (DiscountCode 'OTHER').
/// PriceLevel: 1-4 when the sale was rung up at Price1..4 (31_price_levels.sql); null = SellingPrice.
/// DiscountCap: an SC/PWD discount limited to the booklet's weekly cap (32); its supervisor in DiscountApprovedBy.
public record SaleDto(Guid SaleUid, Guid ShiftUid, string BranchCode, int TerminalId,
    long ORNumber, DateTime BusinessDate, DateTime SaleDateTime,
    decimal GrossAmount, decimal DiscountAmount, decimal VatExemptAmount, decimal VatableAmount,
    decimal VatAmount, decimal ZeroRatedAmount, decimal NetAmount, decimal TenderedAmount,
    decimal ChangeAmount, string? DiscountCode, string? DiscountCtrlNo, string? DiscountName,
    decimal VatAdjustment, int? DinerCount, int? SeniorCount,
    string Status, List<SaleItemDto> Items, List<SalePaymentDto> Payments,
    string? CustomerName = null, string? CustomerAddress = null, string? CustomerTin = null,
    string? CustomerBusinessStyle = null, string? ReceiptText = null, int? CashierUserId = null,
    string? CustomerEmail = null, string? LoyaltyCardNo = null,
    string? ZeroRatedCertNo = null, int? ZeroRatedApprovedBy = null,
    int? DiscountApprovedBy = null, byte? PriceLevel = null, decimal? DiscountCap = null,
    List<WholesaleLineDto>? WholesaleLines = null, int? WholesaleRemovedBy = null,
    List<PromoLineDto>? PromoLines = null, List<CancelledLineDto>? CancelledLines = null,
    List<DiscountLineDto>? DiscountLines = null);

/// "Email a copy" of an invoice or return receipt (Reprint), to any address.
public record EmailCopyRequest(string To);

public record SyncBatchRequest(List<SaleDto> Sales);

/// Per-category override of a discount type's rate/VAT treatment (RA 9994 etc. — e.g.
/// Senior Citizen is 20%+VAT-exempt on medicine but only 5%+still-VATable on groceries).
/// No row for a category means "use the discount type's own default Rate/IsVatExempt".
public record DiscountCategoryRateDto(string DiscountCode, int CategoryId, decimal Rate, bool IsVatExempt);
public record DiscountRateDto(decimal Rate, bool IsVatExempt);

/// A supervisor checking in for an override at the till (price change), before the sale exists.
public record ApproverCheckRequest(string Username, string Password);

/// Assigning a till device to its terminal (TerminalsController.AssignDevice): the approver is
/// only needed when a Cashier is signed in.
public record AssignDeviceRequest(string? ApproverUsername, string? ApproverPassword, string? DeviceLabel);

public record VoidRequest(Guid SaleUid, string Reason,
    string? OverrideUsername, string? OverridePassword);

/// A return transaction against an earlier sales invoice (BIR: tagged RETURN, quotes the
/// Ref SI No.). Lines are the original invoice's LineNo + how much of it comes back.
/// Preview first (no number taken), then commit with the receipt text the terminal built
/// from that preview; its '######' placeholder becomes the 6-digit return number.
public record ReturnLineDto(int LineNo, decimal Quantity);
public record ReturnRequest(Guid ReturnUid, Guid OrigSaleUid, Guid ShiftUid, string Reason,
    List<ReturnLineDto> Items, DateTime? ReturnDateTime, decimal? ExpectedNet, string? ReceiptText,
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
/// PosType: this terminal's own Retail/Restaurant/Pharmacy; null = the branch's PosSettings.PosType.
public record TerminalDto(int TerminalId, string BranchCode, string TerminalCode,
    string TerminalName, string? PrinterTarget, int PaperWidth, string? PrintAgentKey,
    string? Tin, string? AccreditationNo,
    string? SerialNo, string? PermitNo, string? MinNo, DateTime? PermitEffective, bool IsActive,
    string? ErpTerminalCode = null, bool PostToErp = false,
    DateTime? AccreditationDate = null, DateTime? PermitValidUntil = null,
    string? BirRegTransactionNo = null, DateTime? BirApplicationDate = null,
    string? PosType = null,
    string? ScreenLayout = null);   // 37: 'Touch' or 'Grocery'; null = unchanged (an older Admin sends none)

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
    string FromAddress, string ToAddresses, bool EnableSsl, bool SendOnEod, bool IsActive,
    bool SendInvoices = false, string? InvoiceRepository = null);

public record PosSettingsDto(string BranchCode, string PosType, bool VoidOverride,
    bool PriceEditOverride, bool ReprintOverride, bool EodOverride, bool EmailOnBlindClose,
    bool RefundEnabled, bool BlockLoginAfterEod, int OrBlockSize, int OrLowWarning,
    decimal MaxDiscountPerTxn, string? StoreHeader1, string? StoreHeader2, string? ReceiptFooter,
    bool ReturnOverride = true, string? ScaleBarcodePrefix = null, int ScaleCodeLength = 5,
    int ScaleQtyLength = 5, int ScaleQtyDecimals = 3,
    bool? CancelLineOverride = null, bool? XReadOverride = null, bool? DiscountOverride = null,   // 35; null = unchanged
    bool? PriceLevelOverride = null,   // 36
    bool? GiftCertOn = null,           // 38: the branch takes gift certificates; null = unchanged
    bool? OpenDrawerOverride = null);  // 39: opening the drawer with no sale needs a supervisor

/// Accounting (Addendum B): turning the module on picks an industry chart-of-accounts
/// template and the first business date whose End of Day gets posted to the ledger.
public record AccountingSetupRequest(string TemplateCode, DateTime StartDate);

public record PeriodStatusRequest(string Status);

/// Suki / reward cards (LoyaltyController, 26_loyalty.sql).
public record LoyaltySettingsDto(bool IsEnabled, decimal AmountPerPoint, string? ProgramName);
public record PriceLevelDto(byte PriceLevel, string? LevelName, bool IsActive);
/// A wholesale rule for an item (ProductId) or for every item of a category (CategoryId), not both.
public record WholesaleRuleDto(int? ProductId, int? CategoryId, string? BranchCode, decimal MinQty, decimal AmountOff, bool IsActive);
public record WholesaleBranchDto(bool WholesaleOn);
/// A sale line sold at a wholesale price (33_wholesale.sql): the price before it, the amount off per
/// unit, the minimum the sale reached and the item's total quantity in the sale.
public record WholesaleLineDto(int LineNo, decimal RegularPrice, decimal AmountOff, decimal MinQty, decimal ItemTotalQty);
/// A sale line with units free under a promo (34_promos.sql): how many, at what price, and the amount off.
/// 35: a line taken off the cart with a supervisor's approval (audit only).
public record CancelledLineDto(int? ProductId, string? ProductName, decimal Quantity, decimal UnitPrice, int? ApprovedBy);
/// An SC/PWD discount on only the senior's own quantity of a line (e.g. 1 of 3), for the audit.
public record DiscountLineDto(int LineNo, string? ProductName, decimal Quantity, decimal DiscountQty);

/// 35: a terminal's own approval answer for one function (Approvals.Funcs).
public record TerminalApprovalDto(int TerminalId, string Func, bool Required);

/// X-Read with a supervisor's approval when the till needs one (35).
public record XReadRequest(string? OverrideUsername = null, string? OverridePassword = null);

/// A reprint and the supervisor who approved it, when the till needed one (35).
public record ReprintLogRequest(int? ApprovedBy = null);

public record PromoLineDto(int LineNo, int PromoId, string? PromoName, decimal FreeQty, decimal RegularPrice, decimal PromoAmount);
/// A promo (Buy N Take M). Items / CategoryIds qualify; Branches empty = every branch.
public record PromoDto(string? PromoName, string? Kind, int BuyQty, int FreeQty, int? FreeProductId, int? MaxFreePerSale,
    DateTime StartDate, DateTime EndDate, bool IsActive, List<int>? ProductIds, List<int>? CategoryIds, List<string>? Branches);
public record LoyaltyCardDto(string CardNo, string CustomerName, string? Mobile, string? Email, bool IsActive = true);
public record LoyaltyAdjustDto(int Points, string? Note);
