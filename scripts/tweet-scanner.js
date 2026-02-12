const Web3 = require('web3');
const fs = require('fs');
const path = require('path');

// ============ 配置 ============
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const BSC_RPC = "https://bsc-dataseed1.binance.org";
const USDT_CONTRACT = "0x55d398326f99059fF775485246999027B3197955";

// 抽奖配置
const TWEET_REWARD = 10; // 10 USDT
const MIN_BALANCE = 10000; // 最低持仓 10000 MZZ
const DAILY_LIMIT = 3; // 每日最多中奖3次

// ============ 初始化 ============
const web3 = new Web3(BSC_RPC);

// ============ 数据文件 ============
const DATA_DIR = path.join(__dirname, '../data');
const CANDIDATES_FILE = path.join(DATA_DIR, 'candidates.json');
const WINNERS_FILE = path.join(DATA_DIR, 'winners.json');
const PROCESSED_FILE = path.join(DATA_DIR, 'processed.json');
const LAST_DRAW_FILE = path.join(DATA_DIR, 'last-tweet-draw.txt');

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
if (!fs.existsSync(LAST_DRAW_FILE)) {
    fs.writeFileSync(LAST_DRAW_FILE, '0');
}

// ============ 合约ABI ============
const CONTRACT_ABI = [
    {
        "inputs": [],
        "name": "token",
        "outputs": [{"type": "address"}],
        "stateMutability": "view",
        "type": "function"
    }
];

const ERC20_ABI = [
    {
        "inputs": [{"type": "address"}],
        "name": "balanceOf",
        "outputs": [{"type": "uint256"}],
        "stateMutability": "view",
        "type": "function"
    }
];

const USDT_ABI = [
    {
        "inputs": [{"type": "address"}, {"type": "uint256"}],
        "name": "transfer",
        "outputs": [{"type": "bool"}],
        "stateMutability": "nonpayable",
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

// ============ 官方推特 ============
const OFFICIAL_TWITTER = 'mozhuzi06';

// ============ 数据管理 ============
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

function addWinner(wallet, username, tweetId, amount, txHash, source) {
    const data = loadWinners();
    data.winners.push({
        wallet,
        username,
        tweetId,
        amount,
        txHash,
        source,
        time: new Date().toISOString(),
        date: new Date().toISOString().split('T')[0]
    });
    if (data.winners.length > 500) {
        data.winners = data.winners.slice(-500);
    }
    saveWinners(data);
}

function getTodayWins(wallet) {
    const data = loadWinners();
    const today = new Date().toISOString().split('T')[0];
    return data.winners.filter(w => 
        w.wallet.toLowerCase() === wallet.toLowerCase() && 
        w.date === today
    ).length;
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

function getLastDrawTime() {
    return parseInt(fs.readFileSync(LAST_DRAW_FILE, 'utf8'));
}

function setLastDrawTime() {
    fs.writeFileSync(LAST_DRAW_FILE, Date.now().toString());
}

// ============ 抓取推文 ============
async function fetchTweets() {
    // 扫描三个来源：话题标签和官方推特提及
    const keywords = ['#MZZ', '#摸珠子', '@mozhuzi06'];
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
                    
                    // ============ 强制规则：必须包含两个0x地址 ============
                    // 第一个0x地址：代币合约地址
                    // 第二个0x地址：钱包地址
                    if (!addresses || addresses.length < 2) {
                        console.log(`❌ 地址不足: ${tweetId} (只有 ${addresses?.length || 0} 个地址) - 需要代币合约+钱包地址`);
                        markProcessed(tweetId);
                        continue;
                    }
                    
                    const tokenAddress = addresses[0];
                    const walletAddress = addresses[1];
                    
                    // 验证钱包地址格式
                    if (!web3.utils.isAddress(walletAddress)) {
                        console.log(`❌ 无效钱包地址: ${walletAddress}`);
                        markProcessed(tweetId);
                        continue;
                    }
                    
                    // 验证代币地址格式
                    if (!web3.utils.isAddress(tokenAddress)) {
                        console.log(`❌ 无效代币地址: ${tokenAddress}`);
                        markProcessed(tweetId);
                        continue;
                    }
                    
                    // 时间验证：≥1小时
                    const tweetTime = new Date(dateStr);
                    const hoursDiff = (Date.now() - tweetTime) / (1000 * 60 * 60);
                    
                    if (hoursDiff < 1) {
                        console.log(`⏳ 推文未满1小时: ${tweetId} (${hoursDiff.toFixed(1)}小时)`);
                        markProcessed(tweetId);
                        continue;
                    }
                    
                    // 所有验证通过
                    tweets.push({
                        id: tweetId,
                        wallet: walletAddress,
                        token: tokenAddress,
                        username,
                        time: tweetTime.toISOString(),
                        content: cleanContent.slice(0, 100),
                        source: keyword
                    });
                    console.log(`✅ 检测到 [${keyword}]: @${username} 代币:${tokenAddress.slice(0,10)}... 钱包:${walletAddress.slice(0,10)}...`);
                    
                    markProcessed(tweetId);
                }
                
                if (tweets.length > 0) {
                    console.log(`📊 ${keyword} 抓取到 ${tweets.length} 条有效推文`);
                    break;
                }
                
            } catch (error) {
                console.log(`⚠️ ${instance} 搜索 ${keyword} 失败: ${error.message}`);
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
        
        // 必须完全匹配执行合约中记录的代币地址
        const isValid = tokenAddress.toLowerCase() === realToken.toLowerCase();
        
        if (!isValid) {
            console.log(`❌ 代币地址不匹配: 用户提交=${tokenAddress.slice(0,10)}... 正确=${realToken.slice(0,10)}...`);
        }
        
        return isValid;
    } catch (error) {
        console.error('验证代币地址失败:', error.message);
        return false;
    }
}

// ============ 验证持仓 ============
async function verifyBalance(walletAddress, tokenAddress) {
    try {
        const tokenContract = new web3.eth.Contract(ERC20_ABI, tokenAddress);
        const balance = await tokenContract.methods.balanceOf(walletAddress).call();
        const balanceInEth = web3.utils.fromWei(balance, 'ether');
        const hasBalance = parseFloat(balanceInEth) >= MIN_BALANCE;
        
        if (!hasBalance) {
            console.log(`⏭️ 持仓不足: ${walletAddress.slice(0,10)}... (${balanceInEth} MZZ / 需要 ${MIN_BALANCE} MZZ)`);
        }
        
        return hasBalance;
    } catch (error) {
        console.error('验证持仓失败:', error.message);
        return false;
    }
}

// ============ 发送USDT奖励 ============
async function sendUSDT(to, amount) {
    if (!process.env.PRIVATE_KEY) {
        console.log('⚠️ 未配置PRIVATE_KEY，仅记录中奖不发送');
        return '0x' + '0'.repeat(64);
    }
    
    try {
        const account = web3.eth.accounts.privateKeyToAccount(process.env.PRIVATE_KEY);
        web3.eth.accounts.wallet.add(account);
        
        const usdtContract = new web3.eth.Contract(USDT_ABI, USDT_CONTRACT);
        const value = web3.utils.toWei(amount.toString(), 'ether');
        
        const tx = await usdtContract.methods.transfer(to, value).send({
            from: account.address,
            gas: 100000
        });
        
        console.log(`💸 USDT发送成功: ${tx.transactionHash}`);
        return tx.transactionHash;
        
    } catch (error) {
        console.error('USDT发送失败:', error);
        return null;
    }
}

// ============ 执行抽奖 ============
async function drawWinner() {
    const candidates = loadCandidates();
    const eligible = candidates.candidates.filter(c => 
        c.status === 'pending' && 
        !c.processed &&
        new Date(c.time) < new Date(Date.now() - 3600000)
    );
    
    if (eligible.length === 0) {
        console.log('🎲 无候选中推文');
        return null;
    }
    
    // 随机抽取
    const winner = eligible[Math.floor(Math.random() * eligible.length)];
    
    // 检查每日限制
    const todayWins = getTodayWins(winner.wallet);
    if (todayWins >= DAILY_LIMIT) {
        console.log(`⏭️ ${winner.wallet.slice(0,10)}... 今日已中奖 ${todayWins} 次，达到上限`);
        
        const data = loadCandidates();
        const index = data.candidates.findIndex(c => c.id === winner.id);
        if (index !== -1) {
            data.candidates[index].status = 'limited';
            data.candidates[index].processed = true;
            saveCandidates(data);
        }
        return null;
    }
    
    console.log(`🎉 中奖者: @${winner.username} ${winner.wallet.slice(0,10)}...`);
    
    // 发送USDT奖励
    const txHash = await sendUSDT(winner.wallet, TWEET_REWARD);
    
    // 记录获奖
    addWinner(
        winner.wallet,
        winner.username,
        winner.id,
        TWEET_REWARD,
        txHash || 'pending',
        winner.source
    );
    
    // 更新候选者状态
    const data = loadCandidates();
    const index = data.candidates.findIndex(c => c.id === winner.id);
    if (index !== -1) {
        data.candidates[index].status = 'won';
        data.candidates[index].processed = true;
        data.candidates[index].wonAt = new Date().toISOString();
        data.candidates[index].txHash = txHash;
        saveCandidates(data);
    }
    
    return {
        wallet: winner.wallet,
        username: winner.username,
        tweetId: winner.id,
        amount: TWEET_REWARD,
        txHash,
        source: winner.source
    };
}

// ============ 主函数 ============
async function main() {
    console.log('\n' + '='.repeat(60));
    console.log('🚀 推文检测抽奖启动', new Date().toLocaleString());
    console.log('='.repeat(60));
    
    try {
        // 1. 获取真实代币地址
        const contract = new web3.eth.Contract(CONTRACT_ABI, CONTRACT_ADDRESS);
        const realToken = await contract.methods.token().call();
        console.log('✅ 执行合约:', CONTRACT_ADDRESS);
        console.log('✅ 真实代币地址:', realToken);
        console.log('✅ 官方推特: @mozhuzi06');
        console.log('='.repeat(60));
        
        // 2. 抓取推文
        const tweets = await fetchTweets();
        console.log(`📊 本次检测到 ${tweets.length} 条新推文`);
        
        // 3. 验证并保存候选者
        const candidates = loadCandidates();
        let validCount = 0;
        
        for (const tweet of tweets) {
            // 验证代币地址
            const isValidToken = await verifyTokenAddress(tweet.token);
            if (!isValidToken) {
                console.log(`❌ 代币地址错误: ${tweet.token.slice(0,10)}... 来源: ${tweet.source}`);
                continue;
            }
            
            // 验证持仓
            const hasBalance = await verifyBalance(tweet.wallet, realToken);
            if (!hasBalance) {
                continue;
            }
            
            // 检查是否已存在
            const exists = candidates.candidates.some(c => c.id === tweet.id);
            if (!exists) {
                candidates.candidates.push({
                    id: tweet.id,
                    wallet: tweet.wallet,
                    username: tweet.username,
                    token: tweet.token,
                    time: tweet.time,
                    detectedAt: new Date().toISOString(),
                    source: tweet.source,
                    status: 'pending',
                    processed: false
                });
                validCount++;
                console.log(`📝 有效推文: [${tweet.source}] @${tweet.username} 持仓验证通过`);
            }
        }
        
        // 保留最近200条
        if (candidates.candidates.length > 200) {
            candidates.candidates = candidates.candidates.slice(-200);
        }
        
        saveCandidates(candidates);
        console.log(`💾 保存 ${validCount} 条有效推文，当前总候选: ${candidates.candidates.length}`);
        
        // 4. 每小时抽奖
        const lastDraw = getLastDrawTime();
        const hoursSinceLastDraw = (Date.now() - lastDraw) / (1000 * 60 * 60);
        
        if (hoursSinceLastDraw >= 1 || lastDraw === 0) {
            console.log('🎲 执行每小时抽奖...');
            const winner = await drawWinner();
            
            if (winner) {
                console.log(`🏆 抽奖成功: @${winner.username} ${winner.amount} USDT 来源: ${winner.source}`);
                if (winner.txHash && winner.txHash !== '0x' + '0'.repeat(64)) {
                    console.log(`   tx: ${winner.txHash}`);
                }
                setLastDrawTime();
            } else {
                console.log('😢 无人中奖');
            }
        } else {
            const nextDraw = (1 - hoursSinceLastDraw).toFixed(1);
            console.log(`⏳ 距离下次抽奖: ${nextDraw} 小时`);
        }
        
        // 5. 更新前端数据
        await updateFrontendData();
        
        console.log('='.repeat(60));
        console.log('✅ 检测完成');
        console.log('='.repeat(60) + '\n');
        
    } catch (error) {
        console.error('❌ 执行失败:', error);
        process.exit(1);
    }
}

// ============ 更新前端数据 ============
async function updateFrontendData() {
    try {
        const candidates = loadCandidates();
        const winners = loadWinners();
        
        // 获取今日中奖人数
        const today = new Date().toISOString().split('T')[0];
        const todayWinners = winners.winners.filter(w => w.date === today).length;
        
        const data = {
            stats: {
                totalCandidates: candidates.candidates.length,
                pendingCount: candidates.candidates.filter(c => c.status === 'pending').length,
                todayWinners,
                totalWinners: winners.winners.length,
                lastUpdate: new Date().toISOString()
            },
            candidates: candidates.candidates.slice(-20).reverse().map(c => ({
                id: c.id,
                wallet: c.wallet,
                username: c.username,
                token: c.token,
                time: c.time,
                detectedAt: c.detectedAt,
                source: c.source,
                status: c.status
            })),
            winners: winners.winners.slice(-20).reverse().map(w => ({
                wallet: w.wallet,
                username: w.username,
                amount: w.amount,
                time: w.time,
                txHash: w.txHash,
                source: w.source
            }))
        };
        
        // 写入前端数据
        fs.writeFileSync(
            path.join(DATA_DIR, 'frontend-data.json'),
            JSON.stringify(data, null, 2)
        );
        
        // 兼容旧版
        fs.writeFileSync(
            path.join(__dirname, '../data.json'),
            JSON.stringify({
                candidates: candidates.candidates,
                winners: winners.winners,
                lastUpdate: new Date().toISOString()
            }, null, 2)
        );
        
        console.log('📊 前端数据已更新');
        
    } catch (error) {
        console.error('更新前端数据失败:', error);
    }
}

// ============ 执行 ============
if (!globalThis.fetch) {
    globalThis.fetch = require('node-fetch');
}

if (require.main === module) {
    if (!process.env.CONTRACT_ADDRESS) {
        console.error('❌ 错误: 未配置 CONTRACT_ADDRESS');
        process.exit(1);
    }
    
    if (!process.env.PRIVATE_KEY) {
        console.log('⚠️ 警告: 未配置 PRIVATE_KEY，将无法发送USDT奖励');
        console.log('⚠️ 如需自动发奖，请在 GitHub Secrets 添加 PRIVATE_KEY\n');
    }
    
    main();
}

module.exports = { main, drawWinner };
