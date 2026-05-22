# services/sanitizer/recognizers.py — paper2_* additions for the Lucairn Research
# Program Paper 2 (finance / CFPB Consumer Complaint Database / GLBA NPI).
#
# This file documents the recognizer set added to the live sanitizer at
#   /opt/dsa/services/sanitizer/recognizers.py
# on the production gateway (gateway.lucairn.eu) for the Paper 2 benchmark.
#
# Snippet only — paste these entries into RECOGNIZER_DEFINITIONS in the live
# file. They are additive to the existing paper1_* entries from Paper 1, which
# remain registered (cross-paper continuity).
#
# Cite-back:
#   - Recipe + 17-category enumeration: ../../../datasets/finance/RECIPE.md
#   - Paper 1 paper1_* equivalent: ../../paper-1-healthcare/sanitizer-config/recognizers.py
#
# Naming convention: paper2_<category_slug>. Suffix `_ein` / `_itin` for two
# variants of TAX_ID since they have different anchor digit patterns.
#
# All `supported_entity` values use the sanitizer's COLLAPSE bucket "ID" so the
# gateway's value-based ground-truth evaluator counts any covered span as a
# true positive regardless of the recogniser's assigned label. The hipaa
# /glba category mapping table at
#   ../../../src/glba-category-mapping.ts
# documents how the live placeholder vocabulary ([ID_N], [SSN_N], [LOCATION_N],
# etc.) maps to GLBA NPI categories for FP attribution.

PAPER2_RECOGNIZERS = {
    # ---- bank routing (ABA) — exactly 9 digits, context-gated ----
    "paper2_aba_routing": PatternRecognizer(
        supported_entity="ID",
        name="paper2_aba_routing",
        patterns=[Pattern("ABA routing 9-digit", r"\b\d{9}\b", 0.45)],
        context=[
            "routing", "ABA", "wire", "transit", "bank",
            "Routing", "ABA Routing", "ACH",
        ],
    ),

    # ---- bank account number — 8-12 digit, context-gated ----
    # Low confidence on the digit pattern alone because 8-12 digit runs
    # collide heavily with phone numbers, transaction IDs, and complaint IDs.
    # The CFPB narratives are full of digit runs; ONLY fire when account-related
    # context words are present.
    "paper2_bank_account": PatternRecognizer(
        supported_entity="ID",
        name="paper2_bank_account",
        patterns=[Pattern("Bank account 8-12 digit", r"\b\d{8,12}\b", 0.30)],
        context=[
            "account", "checking", "savings", "ACH", "deposit",
            "Account", "Acct", "acct.", "account #", "Account number",
        ],
    ),

    # ---- card CVV — 3-4 digit, STRICT context-gated ----
    # CVV is the highest-FP-risk recognizer in finance: 3-4 digit numbers are
    # everywhere (years, ages, dollar amounts, transaction counts). Only fire
    # when CVV/CVC/security-code is explicitly nearby.
    "paper2_card_cvv": PatternRecognizer(
        supported_entity="ID",
        name="paper2_card_cvv",
        patterns=[Pattern("Card CVV 3-4 digit", r"\b\d{3,4}\b", 0.25)],
        context=[
            "CVV", "CVC", "CVV2", "CVC2", "security code",
            "Card Verification", "verification value",
        ],
    ),

    # ---- card expiration — MM/YY shape ----
    "paper2_card_expiration": PatternRecognizer(
        supported_entity="ID",
        name="paper2_card_expiration",
        patterns=[Pattern("Card expiration MM/YY", r"\b(0[1-9]|1[0-2])/\d{2}\b", 0.5)],
        context=[
            "expir", "valid thru", "card",
            "Exp.", "Expiry", "Expires",
        ],
    ),

    # ---- tax IDs ----
    # EIN: NN-NNNNNNN (e.g. 12-3456789). Distinct from SSN (NNN-NN-NNNN) by
    # both segment lengths and total digit count (9 here vs 11 for SSN).
    "paper2_tax_id_ein": PatternRecognizer(
        supported_entity="ID",
        name="paper2_tax_id_ein",
        patterns=[Pattern("EIN NN-NNNNNNN", r"\b\d{2}-\d{7}\b", 0.65)],
        context=[
            "EIN", "FEIN", "employer", "tax ID", "Tax ID",
            "Federal Tax", "Tax Identification",
        ],
    ),

    # ITIN: 9NN-NN-NNNN (leading-9 variant of SSN shape).
    "paper2_tax_id_itin": PatternRecognizer(
        supported_entity="ID",
        name="paper2_tax_id_itin",
        patterns=[Pattern("ITIN 9NN-NN-NNNN", r"\b9\d{2}-\d{2}-\d{4}\b", 0.75)],
        context=[
            "ITIN", "Individual Taxpayer", "taxpayer",
            "tax ID", "Tax ID",
        ],
    ),

    # ---- driver license (prefix-coded; the injection uses DL- prefix) ----
    # High-confidence pattern because the prefix is distinctive in our synthetic
    # data. Real-world DL numbers vary per state — this recognizer is a model
    # for "tight regex per weak category" but does not generalise to all US
    # driver-license shapes.
    "paper2_driver_license": PatternRecognizer(
        supported_entity="ID",
        name="paper2_driver_license",
        patterns=[Pattern("DL- prefix", r"\bDL-[A-Z0-9]{6,12}\b", 0.95)],
        context=["driver", "license", "DL"],
    ),

    # ---- account balance ($X,XXX.XX) ----
    # Dollar amounts are pervasive in CFPB narratives ("I was charged $35.00...")
    # so the recognizer needs balance/billing context to avoid mass false positives.
    "paper2_account_balance": PatternRecognizer(
        supported_entity="ID",
        name="paper2_account_balance",
        patterns=[Pattern("Dollar amount", r"\$[0-9,]+\.\d{2}\b", 0.40)],
        context=[
            "balance", "amount", "due", "outstanding",
            "current balance", "statement balance",
        ],
    ),

    # ---- credit score (300-850) ----
    # 3-digit numbers in [300, 850] are extremely common in non-credit-score
    # contexts. Require FICO/credit-score context to fire.
    "paper2_credit_score": PatternRecognizer(
        supported_entity="ID",
        name="paper2_credit_score",
        patterns=[Pattern("Credit score 300-850", r"\b[3-8]\d{2}\b", 0.30)],
        context=[
            "credit score", "FICO", "score",
            "VantageScore", "credit rating",
        ],
    ),

    # ---- loan account ID (LN- prefix) ----
    # Like the DL- and ACCT- prefixes from Paper 1: high-confidence pattern
    # because the prefix is distinctive in our synthetic data.
    "paper2_loan_account_id": PatternRecognizer(
        supported_entity="ID",
        name="paper2_loan_account_id",
        patterns=[Pattern("LN- prefix", r"\bLN-[A-Z0-9]{6,15}\b", 0.95)],
        context=[
            "loan", "mortgage", "LN",
            "Loan #", "Mortgage", "auto loan",
        ],
    ),
}

# ---- Honest-caveats note ----
#
# Several of these recognizers (paper2_bank_account, paper2_card_cvv,
# paper2_credit_score, paper2_account_balance) carry deliberately low base
# scores and rely heavily on the `context` list to fire safely. In production
# on real consumer-finance text (vs our synthetic injection), the patterns
# will fire on many ambiguous 3-12 digit numbers. The context-gating limits
# the false-positive blast radius but does not eliminate it. Real-world
# deployment should tune the context word lists per customer's narrative
# vocabulary AND consider raising the base scores AFTER measurement on the
# customer's actual data.
#
# The recognizers paper2_driver_license and paper2_loan_account_id ONLY work
# because our synthetic injection uses the DL- / LN- prefixes; they do not
# generalise to real-world driver-license / loan-account shapes. They exist
# to demonstrate the "tight regex per weak category" pattern, not as
# production-ready definitions.
