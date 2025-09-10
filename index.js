
const express = require('express');
const https = require('https');
const { URLSearchParams } = require('url');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
// 정적(noVNC) 동일 오리진 제공
app.use(express.static('noVNC'));

// Proxmox 설정
const PROXMOX_HOST = '192.168.10.101';
const PROXMOX_PORT = 8006;
const PROXMOX_USERNAME = 'root@pam';
const PROXMOX_PASSWORD = 'tltmxpa1!';


// SSL 인증서 무시 (개발환경용)
//process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = 0;


// proxmox API 요청 함수
async function proxmoxAPI(path, method = 'GET', data = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: PROXMOX_HOST,
      port: PROXMOX_PORT,
      path: path,
      method: method,
      headers: {},
      rejectUnauthorized: false
    };

    // 인증 쿠키/토큰 추가
    if (authTicket) {
      options.headers['Cookie'] = `PVEAuthCookie=${authTicket}`;
    }
    if (csrfToken && method !== 'GET') {
      options.headers['CSRFPreventionToken'] = csrfToken;
    }

    // Body 구성 (Proxmox는 폼 전송 선호)
    let postData = null;
    if (data) {
      if (method === 'GET') {
        // GET의 경우 쿼리스트링으로 처리되어야 함. 호출자가 path에 포함하도록 가정.
      } else {
        options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        postData = new URLSearchParams(data).toString();
        options.headers['Content-Length'] = Buffer.byteLength(postData);
      }
    }

    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', (chunk) => {
        responseData += chunk;
      });
      res.on('end', () => {
        try {
          const jsonData = JSON.parse(responseData);
          resolve(jsonData);
        } catch (e) {
          resolve(responseData);
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}



// 인증 토큰 저장
let authTicket = null;
let csrfToken = null;

// Proxmox 로그인
async function login() {
  try {
    const response = await proxmoxAPI('/api2/json/access/ticket', 'POST', {
      username: PROXMOX_USERNAME,
      password: PROXMOX_PASSWORD
    });

    if (response.data) {
      authTicket = response.data.ticket;
      csrfToken = response.data.CSRFPreventionToken;
      console.log('Proxmox 로그인 성공');
      return true;
    }
    return false;
  } catch (error) {
    console.error('Proxmox 로그인 실패:', error);
    return false;
  }
}


// VM 목록 조회
app.get('/api/vms', async (req, res) => {
  try {
    if (!authTicket) {
      const loginSuccess = await login();
      if (!loginSuccess) {
        return res.status(401).json({ error: '인증 실패' });
      }
    }

    const response = await proxmoxAPI('/api2/json/cluster/resources?type=vm', 'GET');
    res.json(response.data || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// VNC 연결 정보 조회
app.post('/api/vnc/:node/:vmid', async (req, res) => {
  try {
    const { node, vmid } = req.params;
    
    if (!authTicket) {
      const loginSuccess = await login();
      if (!loginSuccess) {
        return res.status(401).json({ error: '인증 실패' });
      }
    }

    // VNC 프록시 생성
    const vncData = await proxmoxAPI(
      `/api2/json/nodes/${node}/qemu/${vmid}/vncproxy`,
      'POST',
      { websocket: 1 }
    );

    if (vncData.data) {
      res.json({
        ticket: vncData.data.ticket,
        port: vncData.data.port,
        cert: vncData.data.cert,
        node: node,
        vmid: vmid
      });
    } else {
      res.status(500).json({ error: 'VNC 프록시 생성 실패' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/', (req, res) => {
    //console.log(__dirname);
    res.sendFile(path.join(__dirname, 'index.html'));
});

// WebSocket 서버 설정 (VNC 프록시용)
function setupWebSocket(server) {
  const wss = new WebSocket.Server({ server, path: '/vnc' });

  wss.on('connection', (ws, req) => {
  console.log('WebSocket 연결됨');
  
  // URL에서 파라미터 추출
  const url = new URL(req.url, `http://${req.headers.host}`);
  const node = url.searchParams.get('node');
  const vmid = url.searchParams.get('vmid');
  const ticket = url.searchParams.get('ticket');
  const port = url.searchParams.get('port');

  if (!node || !vmid || !ticket || !port) {
    ws.close(1000, '필수 파라미터 누락');
    return;
  }

  // Proxmox VNC WebSocket에 연결
  // Proxmox noVNC 엔드포인트로 연결 (정식 경로 사용)
  const proxmoxUrl = `wss://${PROXMOX_HOST}:${PROXMOX_PORT}` +
    `/api2/json/nodes/${node}/qemu/${vmid}/vncwebsocket?port=${encodeURIComponent(port)}&vncticket=${encodeURIComponent(ticket)}`;

  const proxmoxWs = new WebSocket(proxmoxUrl, {
    rejectUnauthorized: false,
    headers: {
      'Cookie': `PVEAuthCookie=${authTicket}`
    }
  });

  // 클라이언트 -> Proxmox
  ws.on('message', (message) => {
    if (proxmoxWs.readyState === WebSocket.OPEN) {
      proxmoxWs.send(message);
    }
  });

  // Proxmox -> 클라이언트
  proxmoxWs.on('message', (message) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  });

  // 연결 종료 처리
  ws.on('close', () => {
    proxmoxWs.close();
  });

  proxmoxWs.on('close', () => {
    ws.close();
  });

  // 에러 처리
  ws.on('error', (error) => {
    console.error('클라이언트 WebSocket 에러:', error);
    proxmoxWs.close();
  });

  proxmoxWs.on('error', (error) => {
    console.error('Proxmox WebSocket 에러:', error);
    ws.close();
  });
  });
}

// 서버 시작
const PORT = 3030;
const server = app.listen(PORT, () => {
  console.log(`백엔드 서버가 포트 ${PORT}에서 실행중입니다`);
  console.log(`정적 파일 서빙: http://localhost:${PORT}/`);
});

// 동일 포트에 WebSocket 서버 부착
setupWebSocket(server);

// 시작시 로그인
login();
