const Web3 = require('web3');
const fs = require('fs');
const path = require('path');

// ============ 配置 ============
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const BSC_RPC = "https://bsc-dataseed1.binance.org";

// ============ 初始化 ============
const web3 = new Web3(BSC_RPC);

// ============ 数据文件 ============
const DATA_DIR = path.join(__dirname, '../data');
const CANDIDATES_FILE = path.join(DATA_DIR, 'candidates.json');
const WINNERS_FILE = path.join(DATA_DIR, 'winners.json');
const PROCESSED_FILE = path.join(DATA_DIR, 'processed.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ============ 初始化文件 ============
if (!fs.existsSync(CANDIDATES_FILE)) {
    fs.writeFileSync(CANDIDATES_FILE, JSON.stringify({ candidates: [] }));
}
if (!fs.existsSync(WINNERS_FILE)) {
    fs.writeFileSync(WINNERS_FILE, JSON.stringify({ winners: [] }));
}
if (!fs.existsSync(PROCESSED_FILE)) {
    fs.writeFileSync(PROCESSED_FILE, JSON.stringify({ ids: [] }));
}

// ============ 合约ABI（只读）============
const CONTRACT_ABI = [
    {
        "inputs": [],
        "name": "token",
        "outputs": [{"type": "address"}],
        "stateMutability": "view",
        "type": "function"
    }
];

// ============ Nitter实例 ============
const NITTER_INSTANCES = [
    'https://nitter.net',
    'https://nitter.lacontrevoie.fr',
    'https://nitter.it',
    'https://nitter.1d4.us',
    'https://nitter.pussthecat.org'
];

// ============ 加载数据 ============
function loadCandidates() {
    return JSON.parse(fs.readFileSync(CANDIDATES_FILE, 'utf8'));
}

function saveCandidates(data) {
    fs.writeFileSync(CANDIDATES_FILE, JSON.stringify(data, null, 2));
}

function loadWinners() {
    return JSON.parse(fs.readFileSync(WINNERS_FILE, 'utf8'));
}

function saveWinners(data) {
    fs.writeFileSync(WINNERS_FILE, JSON.stringify(data, null, 2));
}

function isProcessed(tweetId) {
    const data = JSON.parse(fs.readFileSync(PROCESSED_FILE, 'utf8'));
    return data.ids.includes(tweetId);
}

function markProcessed(tweetId) {
    const data = JSON.parse(fs.readFileSync(PROCESSED_FILE, 'utf8'));
    if (!data.ids.includes(tweetId)) {
        data.ids.push(tweetId);
        data.ids = data.ids.slice(-5000);
        fs.writeFileSync(PROCESSED_FILE, JSON.stringify(data, null, 2));
    }
}

// ============ 抓取推文 ============
async function fetchTweets() {
    const keywords = ['#MZZ', '#摸珠子'];
    const tweets = [];

    for (const keyword of keywords) {
        for (const instance of NITTER_INSTANCES) {
            try {
                console.log(`📡 搜索 ${keyword} 从 ${instance}`);
                
                const url = `${instance}/search?f=tweets&q=${encodeURIComponent(keyword)}`;
                const response = await fetch(url, {
                    headers: { 'User-Agent': 'Mozilla/5.0' },
                    timeout: 8000
                });
                
                if (!response.ok) continue;
                
                const html = await response.text();
                
                const tweetRegex = /<div class="timeline-item".*?>.*?<a href="\/[^"]+\/status\/(\d+)".*?<div class="tweet-content".*?>(.*?)<\/div>.*?<span class="tweet-date"><a[^>]*title="([^"]+)".*?<a class="username" href="\/[^"]+">@([^<]+)<\/a>/gs;
                
                let match;
                while ((match = tweetRegex.exec(html)) !== null) {
                    const [, tweetId, content, dateStr, username] = match;
                    
                    if (isProcessed(tweetId)) continue;
                    
                    const cleanContent = content.replace(/<[^>]+>/g, ' ');
                    const addresses = cleanContent.match(/0x[a-fA-F0-9]{40}/g);
                    
                    if (addresses && addresses.length >= 2) {
                        const tokenAddress = addresses[0];
                        const walletAddress = addresses[1];
                        
                        if (web3.utils.isAddress(walletAddress)) {
                            const tweetTime = new Date(dateStr);
                            const hoursDiff = (Date.now() - tweetTime) / (1000 * 60 * 60);
                            
                            if (hoursDiff >= 1) {
                                tweets.push({
                                    id: tweetId,
                                    wallet: walletAddress,
                                    token: tokenAddress,
                                    username,
                                    time: tweetTime.toISOString(),
                                    content: cleanContent.slice(0, 100)
                                });
                                console.log(`✅ 检测到: @${username} ${walletAddress.slice(0,10)}...`);
                            }
                        }
                    }
                    markProcessed(tweetId);
                }
                
                if (tweets.length > 0) break;
                
            } catch (error) {
                console.log(`⚠️ ${instance} 失败: ${error.message}`);
                continue;
            }
        }
    }
    
    return tweets;
}

// ============ 验证代币地址 ============
async function verifyTokenAddress(tokenAddress) {
    try {
        const contract = new web3.eth.Contract(CONTRACT_ABI, CONTRACT_ADDRESS);
        const realToken = await contract.methods.token().call();
        return tokenAddress.toLowerCase() === realToken.toLowerCase();
    } catch {
        return false;
    }
}

// ============ 主函数 ============
async function main() {
    console.log('\n' + '='.repeat(50));
    console.log('🚀 推文检测启动', new Date().toLocaleString());
    console.log('='.repeat(50));
    
    try {
        // 1. 获取真实代币地址
        const contract = new web3.eth.Contract(CONTRACT_ABI, CONTRACT_ADDRESS);
        const realToken = await contract.methods.token().call();
        console.log('✅ 执行合约:', CONTRACT_ADDRESS);
        console.log('✅ 代币地址:', realToken);
        
        // 2. 抓取推文
        const tweets = await fetchTweets();
        console.log(`📊 本次检测到 ${tweets.length} 条新推文`);
        
        // 3. 验证并保存
        const candidates = loadCandidates();
        const validTweets = [];
        
        for (const tweet of tweets) {
            const isValidToken = await verifyTokenAddress(tweet.token);
            
            if (isValidToken) {
                candidates.candidates.push({
                    id: tweet.id,
                    wallet: tweet.wallet,
                    username: tweet.username,
                    time: tweet.time,
                    detectedAt: new Date().toISOString(),
                    status: 'pending'
                });
                validTweets.push(tweet);
                console.log(`📝 有效推文: @${tweet.username}`);
            } else {
                console.log(`❌ 代币地址错误: ${tweet.token.slice(0,10)}...`);
            }
        }
        
        // 保留最近100条
        if (candidates.candidates.length > 100) {
            candidates.candidates = candidates.candidates.slice(-100);
        }
        
        saveCandidates(candidates);
        console.log(`💾 已保存 ${validTweets.length} 条有效推文`);
        
        console.log('='.repeat(50));
        console.log('✅ 检测完成');
        console.log('='.repeat(50) + '\n');
        
    } catch (error) {
        console.error('❌ 执行失败:', error);
        process.exit(1);
    }
}

// ============ 执行 ============
if (!globalThis.fetch) {
    globalThis.fetch = require('node-fetch');
}

if (require.main === module) {
    main();
}

module.exports = { main };
