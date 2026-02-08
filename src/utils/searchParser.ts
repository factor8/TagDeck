
export type NumericField = 'bpm' | 'year';
export type StringField = 'artist' | 'title' | 'album' | 'genre' | 'label' | 'key' | 'tag' | 'any';

export type FilterOperator = '=' | '>' | '<' | '>=' | '<=' | 'range';

export interface NumericFilter {
  field: NumericField;
  operator: FilterOperator;
  value: number;
  maxValue?: number; // For range
}

export interface StringFilter {
  field: StringField;
  value: string;
  negate: boolean;
  exact: boolean; // For quoted strings
}

export interface SearchQuery {
  stringFilters: StringFilter[];
  numericFilters: NumericFilter[];
}

/**
 * Parses a search string into structured filters.
 * Supports:
 * - Free text: "house music"
 * - Exact phrases: "deep house"
 * - Fields: artist:Prince
 * - Negation: -minimal
 * - Numeric ranges: bpm:120-130, bpm:>120
 */
export function parseSearchQuery(query: string): SearchQuery {
  const result: SearchQuery = {
    stringFilters: [],
    numericFilters: [],
  };

  if (!query) return result;

  // Regex to match tokens:
  // 1. Quoted strings with optional negation/field: (-?field:"value" or -"value" or "value")
  // 2. Range/Comparison with field: (bpm:120-130 or bpm:>120)
  // 3. Simple terms with optional negation/field: (-?field:value or -value or value)
  
  // We'll iterate through the string to pull out tokens
  const tokenRegex = /(?:(-?)([a-z]+):)?(?:"([^"]*)"|([^"\s]+))/gi;
  
  let match;
  while ((match = tokenRegex.exec(query)) !== null) {
    // match[0] is full match
    // match[1] is negation "-" specific to the field prefix context, but strictly we handle negation generally
    
    // Let's break down the structure cleaner.
    // The regex above is a bit ambiguous with the negation placement. 
    // Let's refine the parsing strategy.
    // Instead of one giant regex, let's identify logical chunks.
    // However, regex execution is standard for this.
    
    // Groups in the regex:
    // 1: Negation "-" (if present before field) - actually, standard syntax is -field:value or field:-value? 
    //    Usually -field:value means "NOT field matches value". 
    //    Our specs say "-term" excludes term. 
    //    Let's assume -field:value is valid.
    
    // Let's use a simpler tokenizing approach that splits manually respecting quotes, then parses tokens.
  }
  
  const tokens = tokenize(query);

  for (const token of tokens) {
    parseToken(token, result);
  }

  return result;
}

function tokenize(str: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuote = false;
  
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    
    if (char === '"') {
      inQuote = !inQuote;
      current += char;
    } else if (char === ' ' && !inQuote) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  
  if (current.length > 0) {
    tokens.push(current);
  }
  
  return tokens;
}

function parseToken(token: string, query: SearchQuery) {
  // Check for negation at the start
  let negate = false;
  let rawToken = token;
  
  if (rawToken.startsWith('-')) {
    negate = true;
    rawToken = rawToken.substring(1);
  }

  if (!rawToken) return;

  // Check for field specifier
  // We want to split on the FIRST colon
  const colonIndex = rawToken.indexOf(':');
  
  let field: string = 'any';
  let value: string = rawToken;

  if (colonIndex > -1) {
    const possibleField = rawToken.substring(0, colonIndex).toLowerCase();
    const possibleValue = rawToken.substring(colonIndex + 1);
    
    // Check if valid field
    if (isNumericField(possibleField)) {
        // Handle numeric parsing
        parseNumericToken(possibleField as NumericField, possibleValue, query);
        return; // Numeric tokens don't go to string filters
    } else if (isStringField(possibleField)) {
        field = possibleField;
        value = possibleValue;
    } else {
        // Not a recognized field, treat generic string with colon? 
        // Or strictly enforce? For now, treat "unknown:value" as "any" field with text "unknown:value"
        field = 'any';
        value = rawToken; // Keep original
    }
  }

  // Handle Quotes in value
  let exact = false;
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    value = value.substring(1, value.length - 1);
    exact = true;
  } else if (value.startsWith('"')) {
     // Unclosed quotes - strip starting quote
     value = value.substring(1);
  }

  // If it's a numeric field but didn't trigger above (e.g. bpm:"120"), we treat it as any text search or ignore?
  // Our logic above catches "bpm:..." so we are good.
  
  query.stringFilters.push({
    field: field as StringField,
    value,
    negate,
    exact
  });
}

function isNumericField(f: string): boolean {
    return ['bpm', 'year'].includes(f);
}

function isStringField(f: string): boolean {
    return ['artist', 'title', 'album', 'genre', 'label', 'key', 'tag'].includes(f);
}

function parseNumericToken(field: NumericField, valueStr: string, query: SearchQuery) {
    // Check for range: 120-130
    if (valueStr.includes('-')) {
        const parts = valueStr.split('-');
        const min = parseFloat(parts[0]);
        const max = parseFloat(parts[1]);
        if (!isNaN(min) && !isNaN(max)) {
            query.numericFilters.push({
                field,
                operator: 'range',
                value: min,
                maxValue: max
            });
            return;
        }
    }

    // Check for > or <
    if (valueStr.startsWith('>=')) {
        const val = parseFloat(valueStr.substring(2));
        if (!isNaN(val)) query.numericFilters.push({ field, operator: '>=', value: val });
    } else if (valueStr.startsWith('>')) {
        const val = parseFloat(valueStr.substring(1));
        if (!isNaN(val)) query.numericFilters.push({ field, operator: '>', value: val });
    } else if (valueStr.startsWith('<=')) {
        const val = parseFloat(valueStr.substring(2));
        if (!isNaN(val)) query.numericFilters.push({ field, operator: '<=', value: val });
    } else if (valueStr.startsWith('<')) {
        const val = parseFloat(valueStr.substring(1));
        if (!isNaN(val)) query.numericFilters.push({ field, operator: '<', value: val });
    } else {
        // Exact match
        const val = parseFloat(valueStr);
        if (!isNaN(val)) query.numericFilters.push({ field, operator: '=', value: val });
    }
}
