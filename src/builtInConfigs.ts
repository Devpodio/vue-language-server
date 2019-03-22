
export const builtInConfigs = {
  html: {
    html5: {
      suggest: true
    }
  },
  emmet: {
    showExpandedAbbreviation: 'always',
    showAbbreviationSuggestions: true,
    includeLanguages: {},
    variables: {},
    syntaxProfiles: {},
    excludeLanguages: ['markdown'],
    extensionsPath: null,
    triggerExpansionOnTab: false,
    preferences: {},
    showSuggestionsAsSnippets: false,
    optimizeStylesheetParsing: true
  },
  css: {
    experimental: {
      customData: []
    },
    validate: true,
    lint: {
      compatibleVendorPrefixes: 'ignore',
      vendorPrefix: 'warning',
      duplicateProperties: 'ignore',
      emptyRules: 'warning',
      importStatement: 'ignore',
      boxModel: 'ignore',
      universalSelector: 'ignore',
      zeroUnits: 'ignore',
      fontFaceProperties: 'warning',
      hexColorLength: 'error',
      argumentsInColorFunction: 'error',
      unknownProperties: 'warning',
      validProperties: [],
      ieHack: 'ignore',
      unknownVendorSpecificProperties: 'ignore',
      propertyIgnoredDueToDisplay: 'warning',
      important: 'ignore',
      float: 'ignore',
      idSelector: 'ignore',
      unknownAtRules: 'warning'
    },
    trace: {
      server: 'off'
    }
  }
}