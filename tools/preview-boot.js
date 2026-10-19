/**
 * preview-boot：把 React / react-dom/client / jsx-runtime 暴露成全局，
 * 供真实客户端 bundle 的 require 解析。仅用于本地预览。
 */
import * as React from 'react';
import * as ReactDOMClient from 'react-dom/client';
import * as JsxRuntime from 'react/jsx-runtime';

window.__PREVIEW_REACT__ = React;
window.__PREVIEW_REACT_DOM_CLIENT__ = ReactDOMClient;
window.__PREVIEW_JSX_RUNTIME__ = JsxRuntime;

// bundle 会调用 __ModuleLoader__.load 注册自己
window.__ModuleLoader__ = {
  load(entry) {
    window.__CHATUI_ENTRY__ = entry;
  },
};
