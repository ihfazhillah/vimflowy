import * as _ from 'lodash';
import React from 'react'; // tslint:disable-line no-unused-variable

import * as Plugins from '../../assets/js/plugins';
import Menu from '../../assets/js/menu';
import * as DataStore from '../../assets/js/datastore';
import Document from '../../assets/js/document';
import Session from '../../assets/js/session';
import LineComponent from '../../assets/js/components/line';
import Mutation from '../../assets/js/mutations';
import * as errors from '../../assets/js/errors';
import * as constants from '../../assets/js/constants';
import { Logger } from '../../assets/js/logger';
import Path from '../../assets/js/path';
import { Row } from '../../assets/js/types';

import { INSERT_MOTION_MAPPINGS, SINGLE_LINE_MOTIONS } from '../../assets/js/keyMappings';
import { motionKey } from '../../assets/js/keyDefinitions';

// TODO: do this elsewhere
declare const process: any;

const markStyle = {
  padding: '0px 10px',
  marginRight: 10,
  borderRadius: 6,
};

class MarksPlugin {
  private api: Plugins.PluginApi;
  private logger: Logger;
  private session: Session;
  private document: Document;
  private markstate: {
    session: Session,
    path: Path,
  } | null;
  public SetMark: new(row: Row, mark: string) => Mutation;
  public UnsetMark: new(row: Row) => Mutation;
  private marks_to_paths: {[mark: string]: Path};

  constructor(api) {
    this.api = api;
    this.marks_to_paths = {};
  }

  public async enable() {
    this.logger = this.api.logger;
    this.session = this.api.session;
    this.document = this.session.document;
    const that = this;

    class SetMark extends Mutation {
      private row: Row;
      private mark: string;

      constructor(row, mark) {
        super();
        this.row = row;
        this.mark = mark;
      }
      public str() {
        return `row ${this.row}, mark ${this.mark}`;
      }
      public async mutate(/* session */) {
        await that._setMark(this.row, this.mark);
        await that.api.updatedDataForRender(this.row);
      }
      public async rewind(/* session */) {
        return [
          new UnsetMark(this.row),
        ];
      }
    }
    this.SetMark = SetMark;

    class UnsetMark extends Mutation {
      private row: Row;
      private mark: string;

      constructor(row) {
        super();
        this.row = row;
      }
      public str() {
        return `row ${this.row}`;
      }
      public async mutate(/* session */) {
        this.mark = await that._getMark(this.row);
        await that._unsetMark(this.row, this.mark);
        await that.api.updatedDataForRender(this.row);
      }
      public async rewind(/* session */) {
        return [
          new SetMark(this.row, this.mark),
        ];
      }
    }
    this.UnsetMark = UnsetMark;

    // Serialization #

    this.api.registerHook('document', 'serializeRow', async (struct, info) => {
      const mark = await this._getMark(info.row);
      if (mark) {
        struct.mark = mark;
      }
      return struct;
    });

    this.api.registerListener('document', 'loadRow', async (path, serialized) => {
      if (serialized.mark) {
        const err = await this.updateMark(path.row, serialized.mark);
        if (err) { return this.session.showMessage(err, {text_class: 'error'}); }
      }
    });

    // Commands #

    this.markstate = null;

    this.api.registerMode({
      name: 'MARK',
      cursorBetween: true,
      within_row: true,
      enter: async (session /*, newMode?: ModeId */) => {
        // initialize marks stuff
        const doc = new Document(new DataStore.InMemory());
        await doc.load(constants.empty_data);
        this.markstate = {
          session: new Session(doc),
          path: session.cursor.path,
        };
        await this.markstate.session.setMode('INSERT');
      },
      exit: async (/*session, newMode?: ModeId */) => {
        // do this, now that markstate is cleared
        if (!this.markstate) {
          throw new Error('Mark state null during exit');
        }
        const markedRow = this.markstate.path.row;
        this.markstate = null;
        await this.api.updatedDataForRender(markedRow);
      },
      every: async (/*session*/) => {
        if (!this.markstate) {
          throw new Error('Mark state null during every');
        }
        await this.api.updatedDataForRender(this.markstate.path.row);
      },
      key_transforms: [
        async (key, context) => {
          // must be non-whitespace
          if (key.length === 1) {
            if (/^\S*$/.test(key)) {
              if (this.markstate === null) {
                throw new Error('Mark state null during key transform');
              }
              await this.markstate.session.addCharsAtCursor([{char: key}]);
              await this.api.updatedDataForRender(this.markstate.path.row);
              return [null, context];
            }
          }
          return [key, context];
        },
      ],
    });

    this.api.registerAction(
      'begin-mark',
      'Mark a line',
      async function({ session }) {
        await session.setMode('MARK');
      },
    );

    this.api.registerAction(
      'finish-mark',
      'Finish typing mark',
      async function({ session, keyStream }) {
        if (that.markstate === null) {
          throw new Error('Mark state null in mark mode');
        }
        const mark = await that.markstate.session.curText();
        const markedRow = that.markstate.path.row;
        const err = await that.updateMark(markedRow, mark);
        if (err) { session.showMessage(err, {text_class: 'error'}); }
        await session.setMode('NORMAL');
        keyStream.save();
      }
    );

    this.api.registerMotion(
      'go-mark',
      'Go to the mark indicated by the cursor, if it exists',
      async function({ session }) {
        return async cursor => {
          const word = await session.document.getWord(cursor.row, cursor.col);
          if (word.length < 1 || word[0] !== '@') {
            return false;
          }
          const mark = word.slice(1);
          const allMarks = await that.listMarks();
          if (mark in allMarks) {
            const path = allMarks[mark];
            await session.zoomInto(path);
            return true;
          } else {
            return false;
          }
        };
      },
    );

    this.api.registerAction(
      'delete-mark',
      'Delete mark at cursor',
      async function({ session, keyStream }) {
        const err = await that.updateMark(session.cursor.row, '');
        if (err) { session.showMessage(err, {text_class: 'error'}); }
        keyStream.save();
      },
    );

    this.api.registerAction(
      'search-marks',
      'Go to (search for) a mark',
      async function({ session }) {
        await session.setMode('SEARCH');
        const marks = await that.listMarks();
        session.menu = new Menu(async (text) => {
          // find marks that start with the prefix
          const findMarks = async (document, prefix, nresults = 10) => {
            const results: Array<{
              path: Path, mark: string,
            }> = []; // list of paths
            for (const mark in marks) {
              const path = marks[mark];
              if (mark.indexOf(prefix) === 0) {
                results.push({ path, mark });
                if (nresults > 0 && results.length === nresults) {
                  break;
                }
              }
            }
            return results;
          };

          return await Promise.all(
            (await findMarks(session.document, text)).map(
              async ({ path, mark }) => {
                const line = await session.document.getLine(path.row);
                return {
                  contents: line,
                  renderHook(lineDiv) {
                    return (
                      <span>
                        <span key={`mark_${mark}`} style={markStyle}
                              className='theme-bg-secondary theme-trim'>
                          {mark}
                        </span>
                        {lineDiv}
                      </span>
                    );
                  },
                  fn: async () => await session.zoomInto(path),
                };
              }
            )
          );
        });
      }
    );

    this.api.registerAction(
      'move-cursor-mark',
      'Move the cursor within the mark being edited (according to the specified motion)',
      async function({ motion }) {
        if (that.markstate === null) {
          throw new Error('Mark state null in mark mode');
        }
        await motion(that.markstate.session.cursor, {pastEnd: true});
      },
    );

    this.api.registerAction(
      'mark-delete-char-before',
      'Delete last character (i.e. backspace key)',
      async function() {
        if (that.markstate === null) {
          throw new Error('Mark state null in mark mode');
        }
        await that.markstate.session.deleteAtCursor();
      },
    );

    this.api.registerAction(
      'mark-delete-char-after',
      'Delete character at the cursor (i.e. del key)',
      async function() {
        if (that.markstate === null) {
          throw new Error('Mark state null in mark mode');
        }
        await that.markstate.session.delCharsAfterCursor(1);
      },
    );

    this.api.registerDefaultMappings(
      'MARK',
      Object.assign({
        'toggle-help': [['ctrl+?']],
        'move-cursor-mark': [[motionKey]],
        'finish-mark': [['enter']],
        'mark-delete-char-after': [['delete']],
        'mark-delete-char-before': [['backspace'], ['shift+backspace']],
        'exit-mode': [['esc'], ['ctrl+c']],
      }, _.pick(INSERT_MOTION_MAPPINGS, SINGLE_LINE_MOTIONS))
    );

    this.api.registerDefaultMappings(
      'NORMAL',
      {
        'begin-mark': [['m']],
        'go-mark': [['g', 'm']],
        'delete-mark': [['d', 'm']],
        'search-marks': [['\''], ['`']],
      },
    );

    this.api.registerHook('document', 'pluginRowContents', async (obj, { row }) => {
      const mark = await this._getMark(row);
      const marking = this.markstate && (this.markstate.path.row === row);
      obj.marks = { mark, marking };
      if (this.markstate && marking) {
        obj.marks.markText = await this.markstate.session.document.getLine(
          this.markstate.session.cursor.path.row
        );
        obj.marks.markCol = this.markstate.session.cursor.col;
      }
      return obj;
    });

    this.api.registerHook('session', 'renderLineOptions', (options, info) => {
      if (info.pluginData.marks && info.pluginData.marks.marking) {
        options.cursors = {};
      }
      return options;
    });

    this.api.registerHook('session', 'renderLineContents', (lineContents, info) => {
      const { pluginData } = info;
      if (pluginData.marks) {
        if (pluginData.marks.marking) {
          lineContents.unshift(
            <span style={markStyle} key='mark'
                  className='theme-bg-secondary theme-trim-accent'>
              <LineComponent
                lineData={pluginData.marks.markText}
                cursors={{
                  [pluginData.marks.markCol]: true,
                }}
                cursorBetween={true}
              />
            </span>
          );
        } else {
          const mark = pluginData.marks.mark;
          if (mark) {
            lineContents.unshift(
              <span style={markStyle} key='mark' className='theme-bg-secondary theme-trim'>
                {mark}
              </span>
            );
          }
        }
      }
      return lineContents;
    });

    this.api.registerHook('session', 'renderLineWordHook', (line, info) => {
      const { wordInfo } = info;

      if (this.session.mode === 'NORMAL') {
        if (wordInfo.word[0] === '@') {
          const mark = wordInfo.word.slice(1).replace(/(\.|!|\?)+$/g, '');
          const path = this.marks_to_paths[mark];
          if (path) {
            for (let i = wordInfo.start; i <= wordInfo.end; i++) {
              line[i].renderOptions.type = 'a';
              line[i].renderOptions.onClick = async () => {
                await this.session.zoomInto(path);
                this.session.save();
              };
            }
          }
        }
      }
      return line;
    });

    this.api.registerListener('document', 'afterDetach', async () => {
      this.computeMarksToPaths(); // FIRE AND FORGET
    });
    this.computeMarksToPaths(); // FIRE AND FORGET
  }

  // maintain global marks data structures
  //   a map: row -> mark
  //   and a second map: mark -> row
  private async _getRowsToMarks() {
    return await this.api.getData('ids_to_marks', {});
  }
  private async _setRowsToMarks(rows_to_marks) {
    return await this.api.setData('ids_to_marks', rows_to_marks);
  }
  private async _getMarksToRows() {
    return await this.api.getData('marks_to_ids', {});
  }
  private async _setMarksToRows(mark_to_rows) {
    return await this.api.setData('marks_to_ids', mark_to_rows);
  }

  private async _sanityCheckMarks() {
    if (process.env.NODE_ENV === 'production') {
      return;
    }
    const [
      marks_to_rows,
      rows_to_marks,
    ] = await Promise.all([
      this._getMarksToRows(),
      this._getRowsToMarks(),
    ]);
    const marks_to_rows2 = {};
    for (const row in rows_to_marks) {
      const mark = rows_to_marks[row];
      marks_to_rows2[mark] = parseInt(row, 10);
    }
    errors.assert_deep_equals(marks_to_rows, marks_to_rows2, 'Inconsistent rows_to_marks');
  }

  // get mark for an row, '' if it doesn't exist
  private async _getMark(row) {
    const marks = await this._getRowsToMarks();
    return marks[row] || '';
  }

  private async _setMark(row, mark) {
    await this._sanityCheckMarks();
    const marks_to_rows = await this._getMarksToRows();
    const rows_to_marks = await this._getRowsToMarks();
    errors.assert(!marks_to_rows.hasOwnProperty(mark));
    errors.assert(!rows_to_marks.hasOwnProperty(row));
    marks_to_rows[mark] = row;
    rows_to_marks[row] = mark;
    await this._setMarksToRows(marks_to_rows);
    await this._setRowsToMarks(rows_to_marks);
    await this._sanityCheckMarks();
    this.computeMarksToPaths();
  }

  private async _unsetMark(row, mark) {
    await this._sanityCheckMarks();
    const marks_to_rows = await this._getMarksToRows();
    const rows_to_marks = await this._getRowsToMarks();
    errors.assert_equals(marks_to_rows[mark], row);
    errors.assert_equals(rows_to_marks[row], mark);
    delete marks_to_rows[mark];
    delete rows_to_marks[row];
    await this._setMarksToRows(marks_to_rows);
    await this._setRowsToMarks(rows_to_marks);
    await this._sanityCheckMarks();
    this.computeMarksToPaths();
  }

  // compute set of paths, used for rendering
  // this is a fire and forget function.
  // this.marks_to_paths  is used only for the marks word hook
  // so we don't care if it's a bit out of date
  private computeMarksToPaths() {
    (async () => {
      this.marks_to_paths = await this.listMarks();
    })();
  }

  private async listMarks() {
    await this._sanityCheckMarks();
    const marks_to_rows = await this._getMarksToRows();

    const all_marks = {};
    await Promise.all(
      Object.keys(marks_to_rows).map(async (mark) => {
        const row = marks_to_rows[mark];
        const path = await this.document.canonicalPath(row);
        if (path !== null) {
          all_marks[mark] = path;
        }
      })
    );
    return all_marks;
  }

  // Set the mark for row
  // Returns whether setting mark succeeded
  private async updateMark(row, mark = '') {
    const marks_to_rows = await this._getMarksToRows();
    const rows_to_marks = await this._getRowsToMarks();
    const oldmark = rows_to_marks[row];

    if (!(oldmark || mark)) {
      return 'No mark to delete!';
    }

    if (mark in marks_to_rows) {
      if (marks_to_rows[mark] === row) {
        return 'Already marked, nothing to do!';
      }

      const other_row = marks_to_rows[mark];
      if (await this.document.isAttached(other_row)) {
        return `Mark '${mark}' was already taken!`;
      } else {
        await this.session.do(new this.UnsetMark(other_row));
      }
    }

    if (oldmark) {
      await this.session.do(new this.UnsetMark(row));
    }

    if (mark) {
      await this.session.do(new this.SetMark(row, mark));
    }

    return null;
  }
}

// NOTE: because listing marks filters, disabling is okay

const pluginName = 'Marks';

Plugins.register(
  {
    name: pluginName,
    author: 'Jeff Wu',
    description:
      `Lets you tag a row with a string, and then reference that row with @markname.
  Fast search for marked rows, using '.`,
  },
  async (api) => {
    const marksPlugin = new MarksPlugin(api);
    await marksPlugin.enable();
    return marksPlugin;
  },
  async (api) => {
    api.deregisterAll();
  },
);

export { pluginName };