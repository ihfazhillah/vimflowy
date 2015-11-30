if module?
  global.Modes = require('../modes.coffee')
  global.keyDefinitions= require('../keyDefinitions.coffee')

(() ->
  MODES = Modes.modes

  CMD_SEARCH = keyDefinitions.registerCommand {
    name: 'SEARCH'
    default_hotkeys:
      normal_like: ['/', 'ctrl+f']
  }
  keyDefinitions.registerAction [MODES.NORMAL], CMD_SEARCH, {
    description: 'Search',
  }, () ->
    @view.setMode MODES.SEARCH
    @view.menu = new Menu @view.menuDiv, (chars) =>
      find = (data, query, options = {}) ->
        nresults = options.nresults or 10
        case_sensitive = options.case_sensitive

        results = [] # list of (row_id, index) pairs

        canonicalize = (x) ->
          return if options.case_sensitive then x else x.toLowerCase()

        get_words = (char_array) ->
          return (char_array.join '')
            .split(/\s/g)
            .filter((x) -> x.length)
            .map canonicalize

        query_words = get_words query
        if query.length == 0
          return results

        for row in do data.orderedLines
          line = canonicalize (data.getText row).join ''
          matches = []
          if _.all(query_words.map ((word) ->
                    i = line.indexOf word
                    if i == -1 then return false
                    matches = matches.concat [i...i+word.length]
                    return true
                  ))
            results.push { row: row, matches: matches }
          if nresults > 0 and results.length == nresults
            break
        return results

      return _.map(
        (find @view.data, chars),
        (found) =>
          row = found.row
          highlights = {}
          for i in found.matches
            highlights[i] = true
          return {
            contents: @view.data.getLine row
            renderOptions: { highlights: highlights }
            fn: () => @view.rootInto row
          }
      )

  CMD_MENU_SELECT = keyDefinitions.registerCommand {
    name: 'MENU_SELECT'
    default_hotkeys:
      insert_like: ['enter']
  }
  keyDefinitions.registerAction [MODES.SEARCH], CMD_MENU_SELECT, {
    description: 'Select current menu selection',
  }, () ->
    do @view.menu.select
    @view.setMode MODES.NORMAL

  CMD_MENU_UP = keyDefinitions.registerCommand {
    name: 'MENU_UP'
    default_hotkeys:
      insert_like: ['ctrl+k', 'up', 'tab']
  }
  keyDefinitions.registerAction [MODES.SEARCH], CMD_MENU_UP, {
    description: 'Select previous menu selection',
  }, () ->
    do @view.menu.up

  CMD_MENU_DOWN = keyDefinitions.registerCommand {
    name: 'MENU_DOWN'
    default_hotkeys:
      insert_like: ['ctrl+j', 'down', 'shift+tab']
  }
  keyDefinitions.registerAction [MODES.SEARCH], CMD_MENU_DOWN, {
    description: 'Select next menu selection',
  }, () ->
    do @view.menu.down

)()