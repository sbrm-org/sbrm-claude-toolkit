# Protocol: Spreadsheet / Tracker Build

## Scoping Questions

Ask these before building (or state reasonable defaults if context is clear):

1. **What is this tracking?** Budget, roster, schedule, metrics, inventory, compliance?
2. **Who will use it?** Just you, shared with staff, board-facing, funder reporting?
3. **Input method?** Manual entry, data import, linked to another system?
4. **Update frequency?** Daily, weekly, monthly, quarterly, ad-hoc?
5. **Output needs?** Printable, filterable, feeds into another report, dashboard-ready?

**Default assumptions (single primary user, manual entry, Excel .xlsx format, operational tracking).**

## Required Sections (in order)

1. **Purpose** -- What this spreadsheet does and why (in a comment or Instructions tab)
2. **Schema** -- Every column defined: name, data type, constraints, example value
3. **Formulas** -- Every calculated field explained in plain language alongside the formula
4. **Validation Rules** -- Data validation for every input column (dropdowns, date ranges, number bounds)
5. **Formatting** -- Conditional formatting rules, header styles, print areas
6. **Instructions Tab** -- How to use the spreadsheet, where to enter data, what not to modify

## Build Standards

- **Schema-first**: Define all columns and their types before building
- **Validation on every input**: Dropdowns for categorical data, date pickers for dates, number ranges for quantities
- **Formulas in plain language**: Every formula cell includes a comment explaining the calculation
- **Protected ranges**: Lock formula cells and headers; leave only input cells editable
- **Sample data**: Include 1-3 rows of realistic sample data (marked as sample)
- **Color coding**: Input cells in light blue, calculated cells in light gray, headers in dark with white text
- **No hidden complexity**: If a formula references another sheet, document the dependency

## Acceptance Tests (Definition of Done)

- [ ] Schema documented (column names, types, constraints for every column)
- [ ] Validation rules present for every input column
- [ ] Instructions tab (or sheet) present with usage guidance
- [ ] Sample data row included (clearly marked as sample)
- [ ] Every formula explained in plain language (comment or instructions)
- [ ] Input cells visually distinct from calculated cells
- [ ] Print-friendly if applicable (page breaks, headers repeat)
- [ ] File created using `document-skills:xlsx` plugin

## Common Pitfalls

- Building without schema agreement (leads to restructuring later)
- No validation on input columns (garbage data breaks formulas)
- Formulas that break when rows are inserted or deleted
- Missing instructions (the builder knows how it works; others won't)
- Hardcoded values in formulas instead of reference cells
- No sample data (unclear what format inputs should take)
- Forgetting print layout for spreadsheets that will be printed

## Skeleton

### Instructions Tab Content

```markdown
## [Spreadsheet Name] -- Instructions

**Purpose:** [What this tracks and why]
**Owner:** [Who maintains it]
**Update frequency:** [How often]

### How to Use

1. [Enter data in columns A-F on the "[Sheet Name]" tab]
2. [Do not modify columns G-J (calculated)]
3. [Use dropdowns in column C for [category type]]

### Column Reference

| Column | Name | Type | Notes |
|---|---|---|---|
| A | [Name] | [Text/Date/Number] | [Constraints] |

### Formulas

| Cell/Column | Formula | Plain Language |
|---|---|---|
| G2 | =SUM(D2:F2) | Total of [items] |

### Notes

- [Any dependencies or limitations]
- Sample data in row 2 can be deleted after real data is entered
```

### Data Tab Schema

| Column | Name | Type | Validation | Example |
|---|---|---|---|---|
| A | [Name] | Text | Required | "John Smith" |
| B | [Date] | Date | >= 2024-01-01 | 2026-02-12 |
| C | [Category] | Dropdown | [List values] | "Full-time" |
| D | [Amount] | Currency | >= 0 | $1,500.00 |
