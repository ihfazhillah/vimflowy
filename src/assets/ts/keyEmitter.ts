import $ from 'jquery';
import * as _ from 'lodash';

import * as browser_utils from './utils/browser';
import EventEmitter from './utils/eventEmitter';
import logger from '../../shared/utils/logger';
import { Key } from './types';

/*
KeyEmitter is an EventEmitter that emits keys
A key corresponds to a keypress in the browser, including modifiers/special keys

The core function is to take browser keypress events, and normalize the key to have a string representation.

For more info, see its consumer, keyHandler.ts, as well as keyBindings.ts
Note that one-character keys are treated specially, in that they are insertable in insert mode.
*/

const shiftMap: {[key: string]: Key} = {
  '`': '~',
  '1': '!',
  '2': '@',
  '3': '#',
  '4': '$',
  '5': '%',
  '6': '^',
  '7': '&',
  '8': '*',
  '9': '(',
  '0': ')',
  '-': '_',
  '=': '+',
  '[': '{',
  ']': '}',
  ';': ':',
  '\'': '"',
  '\\': '|',
  '.': '>',
  ',': '<',
  '/': '?',
};

const ignoreMap: {[keyCode: number]: string} = {
  16: 'shift alone',
  17: 'ctrl alone',
  18: 'alt alone',
  91: 'left command alone',
  93: 'right command alone',
};

const keyCodeMap: {[keyCode: number]: Key} = {
  8: 'backspace',
  9: 'tab',
  13: 'enter',
  27: 'esc',
  32: 'space',

  33: 'page up',
  34: 'page down',
  35: 'end',
  36: 'home',
  37: 'left',
  38: 'up',
  39: 'right',
  40: 'down',

  46: 'delete',

  48: '0',
  49: '1',
  50: '2',
  51: '3',
  52: '4',
  53: '5',
  54: '6',
  55: '7',
  56: '8',
  57: '9',

  186: ';',
  187: '=',
  188: ',',
  189: '-',
  190: '.',
  191: '/',
  192: '`',

  219: '[',
  220: '\\',
  221: ']',
  222: '\'',
};


// should be handled by keypress
const keyCodes = [
  'KeyA',
  'KeyB',
  'KeyC',
  'KeyD',
  'KeyE',
  'KeyF',
  'KeyG',
  'KeyH',
  'KeyI',
  'KeyJ',
  'KeyK',
  'KeyL',
  'KeyM',
  'KeyN',
  'KeyO',
  'KeyP',
  'KeyQ',
  'KeyR',
  'KeyS',
  'KeyT',
  'KeyU',
  'KeyV',
  'KeyW',
  'KeyX',
  'KeyY',
  'KeyZ',
  'Digit1',
  'Digit2',
  'Digit3',
  'Digit4',
  'Digit5',
  'Digit6',
  'Digit7',
  'Digit8',
  'Digit9',
  'Digit0',
  'Minus',
  'Equal',
  'BracketLeft',
  'BracketRight',
  'BackSlash',
  'Semicolon',
  'Quote',
  'Comma',
  'Period',
  'Slash',
  'Backquote'
];

for (let j = 1; j <= 26; j++) {
  const keyCode = j + 64;
  const letter = String.fromCharCode(keyCode);
  const lower = letter.toLowerCase();
  keyCodeMap[keyCode] = lower;
  shiftMap[lower] = letter;
}

if (browser_utils.isFirefox()) {
  keyCodeMap[173] = '-';
}

export default class KeyEmitter extends EventEmitter {
  // constructor() {
  //   super();
  // }

  public listen() {
    // IME event
    $(document).on('compositionend', (e: any) => {
      e.originalEvent.data.split('').forEach((key: string) => {
        console.log(`ihfazh -> in compositionend key: ${key}`);
        this.emit('keydown', key);
      });
    });

    // todo: need to handle:
    // shift key in the insert mode to give us the actual data
    // android soft keyboard

    $(document).on('keypress', (e) => {

      console.log({name: 'keypress', keyCode: e.keyCode, code: e.code, charCode: e.charCode});
      if (e.shiftKey) {
        if (keyCodes.find(code => e.code === code) !== undefined){
          this.emit('keydown', e.key);
          return;
        }
      }

      const isSpecial = _.some([e.altKey, e.shiftKey, e.metaKey, e.ctrlKey]);
      if (isSpecial) {
        return;
      }

      this.emit('keydown', e.key);

    });

    // we need to handle key press and keydown here
    // we can handle any language with keypress
    // but we cannot handle something like backspace in keypress, we need use keydown
    return $(document).on('keydown', e => {
      // IME input keycode is 229
      if (e.keyCode === 229) {
        return false;
      }
      if (e.keyCode in ignoreMap) {
        return true;
      }

      const isSpecial = _.some([e.ctrlKey, e.metaKey, e.altKey]);
      const nonCharactersCode = [
        27, // escape
        37, 38, 39, 40, // arrows
        35, // home
        36, // end
        45, // insert
        46, // delete
        20, // capslock
        9, // tab
        8, // backspace
        13, // enter
      ];
      if (!isSpecial && nonCharactersCode.find(code => e.keyCode === code) === undefined) {
        return true;
      }

      // if (e.shiftKey) {
      //   if (keyCodes.find(code => e.code === code) === undefined){
      //     return;
      //   }
      // }

      let key;
      if (e.keyCode in keyCodeMap) {
        key = keyCodeMap[e.keyCode];
      } else {
        // this is necessary for typing stuff..
        key = String.fromCharCode(e.keyCode);
      }

      if (e.shiftKey) {
        if (key in shiftMap) {
          key = shiftMap[key];
        } else {
          key = `shift+${key}`;
        }
      }

      if (e.altKey) {
        key = `alt+${key}`;
      }

      if (e.ctrlKey) {
        key = `ctrl+${key}`;
      }

      if (e.metaKey) {
        key = `meta+${key}`;
      }

      const results = this.emit('keydown', key);
      // return false to stop propagation, if any handler handled the key
      if (_.some(results)) {
        e.stopPropagation();
        e.preventDefault();
        return false;
        // return browser_utils.cancel(e);
      }
      return true;
    });
  }
}
