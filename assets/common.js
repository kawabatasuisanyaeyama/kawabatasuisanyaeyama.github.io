/**
 * =============================================================================
 * 川畑水産 システム共通ライブラリ (assets/common.js)
 * @version 2.1.0
 * @lastModified 2026-11-25 07:15:00 JST
 * @note セキュリティ刷新: LINE IDトークン検証 / スタッフセッショントークン / デフォルト拒否API
 * =============================================================================
 */

(function (window) {
  'use strict';

  // ---------------------------------------------------------------------------
  // 1. 環境設定・識別子定数
  // ---------------------------------------------------------------------------
  const KawabataConfig = {
    // GAS Web App 本番エンドポイント
    GAS_API_URL: "https://script.google.com/macros/s/AKfycbxIYsPdreUjaOFutfshhQIwOLb_Ke1JprcDZj_LAT9oZnc-l-3jZLsPAsFd_QdQJAQ4eA/exec",

    // 顧客用 LINE LIFF ID (index.html / request.html)
    // ※13文字目は大文字 "I"
    LIFF_ID_CUSTOMER: "2011871129-P4IflaGc",

    // 社内スタッフ用 LINE LIFF ID (picking / stock / boat / collect)
    // ※人間側でLINE Developersにて別途作成するまで、初期値として顧客用IDまたは空文字を設定可能
    LIFF_ID_STAFF: "2011871129-P4IflaGc",

    // 公式LINEアカウントID
    OFFICIAL_LINE_ID: "@721pyqfn",

    // ストレージキー
    STORAGE_KEYS: {
      STAFF_SESSION_TOKEN: 'kawabata_staff_session_token',
      STAFF_USER_INFO: 'kawabata_staff_user_info',
      CATALOG_CACHE: 'kawabata_catalog_cache_v1',
      CART_CACHE: 'kawabata_cart_cache_v1',
      NG_DATES_CACHE: 'kawabata_ng_dates_v1',
      BOAT_ORDERS: 'kawabata_boat_orders_v1',
      COLLECT_QUEUE: 'kawabata_collect_sync_queue_v1'
    }
  };

  // ---------------------------------------------------------------------------
  // 2. セキュリティ・XSSサニタイズ関数
  // ---------------------------------------------------------------------------
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // URLパラメータ等からのデバッグモード判定 (?debug=1)
  function isDebugMode() {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get('debug') === '1';
    } catch (e) {
      return false;
    }
  }

  // 安全なデバッグログ（本番では出力抑止）
  function debugLog(...args) {
    if (isDebugMode()) {
      console.log('[DEBUG]', ...args);
    }
  }

  // ---------------------------------------------------------------------------
  // 3. API通信ラッパー (POST / text/plain によるプリフライト回避・トークン自動付与)
  // ---------------------------------------------------------------------------
  /**
   * @param {string} action - APIアクション名
   * @param {object} payload - 送信データ
   * @param {object} options - { auth: 'customer' | 'staff' | 'public', timeout: 30000 }
   * @returns {Promise<object>}
   */
  async function apiCall(action, payload = {}, options = {}) {
    const authType = options.auth || 'customer';
    const timeoutMs = options.timeout || 30000;

    const requestBody = Object.assign({}, payload, { action: action });

    // 認証トークンの付与
    if (authType === 'customer') {
      let idToken = null;
      if (typeof liff !== 'undefined' && liff.isLoggedIn && liff.isLoggedIn()) {
        try {
          idToken = liff.getIDToken();
        } catch (e) {
          debugLog('Failed to get ID token:', e);
        }
      }
      requestBody.idToken = idToken || "";
    } else if (authType === 'staff') {
      const sessionToken = localStorage.getItem(KawabataConfig.STORAGE_KEYS.STAFF_SESSION_TOKEN) || "";
      requestBody.sessionToken = sessionToken;
    }

    debugLog(`[apiCall] action=${action}, authType=${authType}`);

    // fetchタイムアウト制御
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(KawabataConfig.GAS_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain;charset=utf-8' // CORSプリフライト回避
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        throw new Error(`HTTPエラー ${res.status}`);
      }

      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (parseErr) {
        throw new Error("サーバーからの応答を解析できませんでした。");
      }

      // 共通認証エラーハンドリング
      if (data.status === 'error') {
        if (data.code === 'AUTH_REQUIRED' || data.code === 'SESSION_EXPIRED') {
          handleAuthFailure(authType, data);
        }
      }

      return data;
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        throw new Error("通信がタイムアウトしました。電波の良い場所でお試しください。");
      }
      throw err;
    }
  }

  // 認証失敗時のハンドリング
  function handleAuthFailure(authType, errorResponse) {
    debugLog('[handleAuthFailure]', authType, errorResponse);
    if (authType === 'customer') {
      // 顧客画面: LIFFログインへ誘導
      if (typeof liff !== 'undefined' && liff.login) {
        if (confirm("LINE認証の有効期限が切れました。\n再度LINEログインを行ってください。")) {
          liff.login({ redirectUri: window.location.href });
        }
      }
    } else if (authType === 'staff') {
      // 社内画面: セッショントークンを破棄してログインモーダル表示
      localStorage.removeItem(KawabataConfig.STORAGE_KEYS.STAFF_SESSION_TOKEN);
      localStorage.removeItem(KawabataConfig.STORAGE_KEYS.STAFF_USER_INFO);
      showStaffLoginModal("セッションの有効期限が切れたか、無効化されました。再ログインしてください。");
    }
  }

  // ---------------------------------------------------------------------------
  // 4. 社内スタッフ用認証・端末管理UIコンポーネント
  // ---------------------------------------------------------------------------
  let staffAuthCallback = null;

  /**
   * 社内画面初期化時に呼び出す認証ガード
   * @param {string} requiredRole - 'shipping' | 'stock' | 'boat' | 'admin'
   * @param {function} onAuthenticated - 認証成功時のコールバック (userInfo)
   */
  async function initStaffAuth(requiredRole, onAuthenticated) {
    staffAuthCallback = onAuthenticated;

    // 既にローカルにセッショントークンがあるか確認
    const sessionToken = localStorage.getItem(KawabataConfig.STORAGE_KEYS.STAFF_SESSION_TOKEN);
    const userInfoRaw = localStorage.getItem(KawabataConfig.STORAGE_KEYS.STAFF_USER_INFO);

    if (sessionToken && userInfoRaw) {
      try {
        const userInfo = JSON.parse(userInfoRaw);
        // バックグラウンドでセッション有効性を確認（オフライン時はキャッシュで通過）
        if (navigator.onLine) {
          apiCall('verifySession', {}, { auth: 'staff' })
            .then(res => {
              if (res.status === 'success') {
                // 有効
                if (typeof onAuthenticated === 'function') onAuthenticated(res.user);
              } else {
                // 無効または権限不足
                handleAuthFailure('staff', res);
              }
            })
            .catch(e => {
              // ネットワークエラー等はオフライン動作を許容
              debugLog('verifySession network catch, permitting offline usage:', e);
              if (typeof onAuthenticated === 'function') onAuthenticated(userInfo);
            });
        } else {
          // オフライン時は即時通過
          if (typeof onAuthenticated === 'function') onAuthenticated(userInfo);
        }
        return;
      } catch (e) {
        localStorage.removeItem(KawabataConfig.STORAGE_KEYS.STAFF_SESSION_TOKEN);
      }
    }

    // 未認証ならログインモーダルを表示
    showStaffLoginModal();
  }

  // スタッフ用ログインモーダルのDOM生成と表示
  function showStaffLoginModal(errorMessage = "") {
    let modal = document.getElementById('kawabata-staff-auth-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'kawabata-staff-auth-modal';
      modal.innerHTML = `
        <style>
          #kawabata-staff-auth-modal {
            position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(15, 23, 42, 0.85); backdrop-filter: blur(4px);
            display: flex; align-items: center; justify-content: center;
            z-index: 99999; padding: 16px; font-family: -apple-system, sans-serif;
          }
          .kawabata-auth-card {
            background: #ffffff; width: 100%; max-width: 400px;
            border-radius: 14px; padding: 24px 20px; box-shadow: 0 10px 25px rgba(0,0,0,0.25);
            text-align: center;
          }
          .kawabata-auth-title { font-size: 1.15rem; font-weight: bold; color: #005bac; margin-bottom: 4px; }
          .kawabata-auth-sub { font-size: 0.8rem; color: #64748b; margin-bottom: 18px; }
          .kawabata-auth-err { background: #fee2e2; border: 1px solid #fca5a5; color: #dc2626; font-size: 0.78rem; padding: 8px 10px; border-radius: 6px; margin-bottom: 14px; text-align: left; }
          .kawabata-auth-btn-line {
            width: 100%; background: #06c755; color: #fff; border: none; border-radius: 8px;
            padding: 13px; font-size: 0.95rem; font-weight: bold; cursor: pointer; display: flex;
            align-items: center; justify-content: center; gap: 8px; margin-bottom: 16px;
          }
          .kawabata-auth-divider { display: flex; align-items: center; color: #94a3b8; font-size: 0.75rem; margin-bottom: 16px; }
          .kawabata-auth-divider::before, .kawabata-auth-divider::after { content: ""; flex: 1; height: 1px; background: #e2e8f0; }
          .kawabata-auth-divider span { padding: 0 8px; }
          .kawabata-code-input {
            width: 100%; padding: 11px; font-size: 1.2rem; font-weight: bold; letter-spacing: 4px;
            text-align: center; border: 1.5px solid #cbd5e1; border-radius: 8px; margin-bottom: 10px;
            box-sizing: border-box; outline: none;
          }
          .kawabata-code-input:focus { border-color: #005bac; }
          .kawabata-auth-btn-code {
            width: 100%; background: #005bac; color: #fff; border: none; border-radius: 8px;
            padding: 11px; font-size: 0.88rem; font-weight: bold; cursor: pointer;
          }
        </style>
        <div class="kawabata-auth-card">
          <div style="font-size: 2.2rem; margin-bottom: 4px;">🔐</div>
          <div class="kawabata-auth-title">川畑水産 社内認証</div>
          <div class="kawabata-auth-sub">社内スタッフ専用コンソールへのアクセス認証</div>

          <div id="kawabata-auth-error-box" class="kawabata-auth-err" style="${errorMessage ? '' : 'display:none;'}">
            ${escapeHtml(errorMessage)}
          </div>

          <!-- LINEログイン -->
          <button type="button" class="kawabata-auth-btn-line" id="btn-staff-line-login">
            <svg viewBox="0 0 24 24" width="20" height="20"><path fill="#fff" d="M12 2C6.48 2 2 5.92 2 10.76c0 3.1 1.83 5.83 4.67 7.27-.2.74-.75 2.68-.86 3.09-.13.51.19.5.39.37.16-.1 2.22-1.52 3.12-2.14.88.13 1.77.2 2.68.2 5.52 0 10-3.92 10-8.76S17.52 2 12 2z"/></svg>
            LINEでスタッフログイン
          </button>

          <div class="kawabata-auth-divider"><span>または共有端末コード</span></div>

          <!-- 共有端末コード入力 -->
          <div>
            <input type="text" id="kawabata-shared-code" class="kawabata-code-input" placeholder="6桁コード" maxlength="6" inputmode="numeric">
            <button type="button" class="kawabata-auth-btn-code" id="btn-staff-code-login">
              端末登録コードで認証 (出荷専用)
            </button>
          </div>
          <div style="font-size: 0.72rem; color: #94a3b8; margin-top: 12px; line-height: 1.4;">
            ※作業場共有タブレット等は、管理者が発行した6桁コードでログインできます（10分有効）。
          </div>
        </div>
      `;
      document.body.appendChild(modal);

      // イベントリスナー設定
      document.getElementById('btn-staff-line-login').addEventListener('click', execStaffLineLogin);
      document.getElementById('btn-staff-code-login').addEventListener('click', execSharedCodeLogin);
    } else {
      modal.style.display = 'flex';
      const errBox = document.getElementById('kawabata-auth-error-box');
      if (errBox) {
        if (errorMessage) {
          errBox.innerText = errorMessage;
          errBox.style.display = 'block';
        } else {
          errBox.style.display = 'none';
        }
      }
    }
  }

  // スタッフLINEログイン実行
  async function execStaffLineLogin() {
    if (typeof liff === 'undefined') {
      alert("LINE SDKの読み込みに失敗しました。ページを再読み込みしてください。");
      return;
    }
    try {
      if (!liff.isLoggedIn()) {
        liff.login({ redirectUri: window.location.href });
        return;
      }
      const idToken = liff.getIDToken();
      if (!idToken) {
        liff.login({ redirectUri: window.location.href });
        return;
      }

      // GASへスタッフログインリクエスト
      const res = await apiCall('staffLogin', { idToken: idToken }, { auth: 'public' });
      if (res.status === 'success' && res.sessionToken) {
        localStorage.setItem(KawabataConfig.STORAGE_KEYS.STAFF_SESSION_TOKEN, res.sessionToken);
        localStorage.setItem(KawabataConfig.STORAGE_KEYS.STAFF_USER_INFO, JSON.stringify(res.user));
        document.getElementById('kawabata-staff-auth-modal').style.display = 'none';
        if (typeof staffAuthCallback === 'function') staffAuthCallback(res.user);
      } else {
        const errBox = document.getElementById('kawabata-auth-error-box');
        if (errBox) {
          errBox.innerText = res.message || "スタッフマスタに登録されていないか、無効化されています。";
          errBox.style.display = 'block';
        }
      }
    } catch (e) {
      alert("ログイン処理中にエラーが発生しました: " + e.message);
    }
  }

  // 共有端末コードログイン実行
  async function execSharedCodeLogin() {
    const codeInput = document.getElementById('kawabata-shared-code');
    const code = codeInput ? codeInput.value.trim() : '';
    if (!code || code.length !== 6) {
      alert("6桁の登録コードを入力してください。");
      return;
    }

    try {
      const res = await apiCall('registerSharedDevice', { deviceCode: code }, { auth: 'public' });
      if (res.status === 'success' && res.sessionToken) {
        localStorage.setItem(KawabataConfig.STORAGE_KEYS.STAFF_SESSION_TOKEN, res.sessionToken);
        localStorage.setItem(KawabataConfig.STORAGE_KEYS.STAFF_USER_INFO, JSON.stringify(res.user));
        document.getElementById('kawabata-staff-auth-modal').style.display = 'none';
        if (typeof staffAuthCallback === 'function') staffAuthCallback(res.user);
      } else {
        const errBox = document.getElementById('kawabata-auth-error-box');
        if (errBox) {
          errBox.innerText = res.message || "コードが無効か、有効期限が切れています。";
          errBox.style.display = 'block';
        }
      }
    } catch (e) {
      alert("コード認証中にエラーが発生しました: " + e.message);
    }
  }

  // 管理者向け: 共有端末登録コードの発行モーダル/API
  async function issueSharedDeviceCode() {
    try {
      const res = await apiCall('issueDeviceCode', {}, { auth: 'staff' });
      if (res.status === 'success') {
        prompt("共有端末で以下の6桁コードを入力してください（有効期限: 10分・1回限り）:", res.deviceCode);
      } else {
        alert("コード発行に失敗しました: " + (res.message || '管理者権限が必要です'));
      }
    } catch (e) {
      alert("通信エラー: " + e.message);
    }
  }

  // スタッフログアウト
  function staffLogout() {
    if (confirm("スタッフセッションをログアウトしますか？")) {
      const sessionToken = localStorage.getItem(KawabataConfig.STORAGE_KEYS.STAFF_SESSION_TOKEN);
      if (sessionToken) {
        apiCall('staffLogout', {}, { auth: 'staff' }).catch(() => {});
      }
      localStorage.removeItem(KawabataConfig.STORAGE_KEYS.STAFF_SESSION_TOKEN);
      localStorage.removeItem(KawabataConfig.STORAGE_KEYS.STAFF_USER_INFO);
      location.reload();
    }
  }

  // ---------------------------------------------------------------------------
  // 5. グローバル公開
  // ---------------------------------------------------------------------------
  window.Kawabata = {
    Config: KawabataConfig,
    config: KawabataConfig,
    escapeHtml: escapeHtml,
    isDebugMode: isDebugMode,
    debugLog: debugLog,
    apiCall: apiCall,
    fetchProducts: function (options) {
      return apiCall('fetchProducts', {}, Object.assign({ auth: 'customer' }, options));
    },
    submitOrder: function (payload, options) {
      return apiCall('order', payload, Object.assign({ auth: 'customer' }, options));
    },
    getMyProfile: function (options) {
      return apiCall('getMyProfile', {}, Object.assign({ auth: 'customer' }, options));
    },
    submitSpecimenRequest: function (payload, options) {
      return apiCall('request', payload, Object.assign({ auth: 'customer' }, options));
    },
    registerCustomer: function (payload, options) {
      return apiCall('apply', payload, Object.assign({ auth: 'customer' }, options));
    },
    initStaffAuth: initStaffAuth,
    showStaffLoginModal: showStaffLoginModal,
    issueSharedDeviceCode: issueSharedDeviceCode,
    staffLogout: staffLogout
  };

})(window);
