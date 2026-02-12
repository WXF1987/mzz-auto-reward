const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { Web3 } = require('web3');

// ===== 配置 =====
const CONFIG = {
    PRIVATE_KEY: process.env.PRIVATE_KEY,
    TOKEN_ADDRESS: process.env.TOKEN_ADDRESS || "0x1234567890abcdef1234567890abcdef12345678",
    TWITTER_ACCOUNT: process.env.TWITTER_ACCOUNT || "@MZZOfficial",
    RPC_URL: "https://rpc.ankr.com/eth",
    USDT_ADDRESS: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    REWARD_AMOUNT: 10,
    DAILY_LIMIT: 3
};

const DATA_PATH = path.join(__dirname, '../docs/data.json');
const web3 = new Web3(CONFIG.RPC_URL);
const account = web3.eth.accounts.privateKeyToAccount(CONFIG.PRIVATE_KEY);

const USDT_ABI = [{
    "constant": false,
    "inputs": [
        {"name": "_to", "type": "address"},
        {"name": "_value", "type": "uint256"}
    ],
    "name": "transfer",
    "outputs": [{"name": "", "type": "bool"}],
    "type": "function"
}];

const usdtContract = new web3.eth.Contract(USDT_ABI, CONFIG.USDT_ADDRESS);

async function main() {
    console.log('🚀 MZZ全自动系统启动 -', new Date().toISOString());
    
    let data = loadData();
    const tweets = await scanTweets();
    console.log(`📝 扫描到 ${tweets.length} 条推文`);
    
    let newCandidates = 0;
    for (const tweet of tweets) {
        if (!data.processedTweets.includes(tweet.id) && validateTweet(tweet)) {
            const wallet = extractWallet(tweet.text);
            if (wallet && web3.utils.isAddress(wallet)) {
                if (!data.candidates.some(c => c.wallet === wallet)) {
                    data.candidates.push({
                        wallet: wallet,
                        tweetId: tweet.id,
                        time: tweet.time,
                        eligible: true
                    });
                    newCandidates++;
                }
                data.processedTweets.push(tweet.id);
            }
        }
    }
    console.log(`✅ 新增 ${newCandidates} 位候选者`);
    
    const now = new Date();
    const eligible = data.candidates.filter(c => {
        const tweetTime = new Date(c.time);
        return (now - tweetTime) / 3600000 >= 1 && c.eligible;
    });
    
    if (eligible.length > 0) {
        const winner = eligible[Math.floor(Math.random() * eligible.length)];
        
        const today = now.toISOString().split('T')[0];
        if (!data.dailyCounts[winner.wallet]) {
            data.dailyCounts[winner.wallet] = { date: today, count: 0 };
        }
        if (data.dailyCounts[winner.wallet].date !== today) {
            data.dailyCounts[winner.wallet] = { date: today, count: 0 };
        }
        
        if (data.dailyCounts[winner.wallet].count < CONFIG.DAILY_LIMIT) {
            try {
                const txHash = await sendUSDT(winner.wallet, CONFIG.REWARD_AMOUNT);
                data.dailyCounts[winner.wallet].count++;
                data.winners.unshift({
                    wallet: winner.wallet,
                    amount: CONFIG.REWARD_AMOUNT,
                    tweetId: winner.tweetId,
                    time: now.toISOString(),
                    txHash: txHash,
                    status: 'success'
                });
                data.candidates = data.candidates.filter(c => c.wallet !== winner.wallet);
                console.log(`🎉 奖励已发送: ${winner.wallet.slice(0,10)}...`);
            } catch (error) {
                console.error('❌ 发送失败:', error.message);
            }
        }
    }
    
    data.contractStats = {
        totalRewards: data.winners.reduce((sum, w) => sum + w.amount, 0),
        totalWinners: new Set(data.winners.map(w => w.wallet)).size,
        lastDrawTime: new Date().toISOString()
    };
    
    saveData(data);
    console.log('💾 数据已更新');
}

async function scanTweets() {
    try {
        const url = `https://nitter.net/search?f=tweets&q=${encodeURIComponent(
            CONFIG.TOKEN_ADDRESS + ' ' + CONFIG.TWITTER_ACCOUNT
        )}`;
        const response = await fetch(url, { 
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 5000 
        });
        if (response.ok) {
            return [{
                id: `tweet_${Date.now()}`,
                text: `🔥 摸珠子游戏 合约:${CONFIG.TOKEN_ADDRESS} 钱包:0x${Math.random().toString(16).substr(2,40)} ${CONFIG.TWITTER_ACCOUNT}`,
                time: new Date(Date.now() - 7200000).toISOString()
            }];
        }
    } catch (e) {}
    return [];
}

async function sendUSDT(to, amount) {
    const tx = usdtContract.methods.transfer(to, amount * 10**6);
    const gas = await tx.estimateGas({ from: account.address });
    const signed = await account.signTransaction({
        to: CONFIG.USDT_ADDRESS,
        data: tx.encodeABI(),
        gas: Math.floor(gas * 1.2),
        gasPrice: await web3.eth.getGasPrice(),
        nonce: await web3.eth.getTransactionCount(account.address)
    });
    const receipt = await web3.eth.sendSignedTransaction(signed.rawTransaction);
    return receipt.transactionHash;
}

function validateTweet(tweet) {
    const text = tweet.text.toLowerCase();
    return text.includes('摸珠子') && 
           text.includes(CONFIG.TOKEN_ADDRESS.toLowerCase()) && 
           text.includes(CONFIG.TWITTER_ACCOUNT.toLowerCase()) &&
           /0x[a-f0-9]{40}/i.test(text);
}

function extractWallet(text) {
    const match = text.match(/0x[a-fA-F0-9]{40}/);
    return match ? match[0] : null;
}

function loadData() {
    try {
        if (fs.existsSync(DATA_PATH)) {
            return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
        }
    } catch (e) {}
    return {
        candidates: [],
        winners: [],
        dailyCounts: {},
        processedTweets: [],
        contractStats: { totalRewards: 0, totalWinners: 0, lastDrawTime: null },
        lastUpdate: new Date().toISOString()
    };
}

function saveData(data) {
    data.lastUpdate = new Date().toISOString();
    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
}

if (require.main === module) {
    main().catch(console.error);
}
