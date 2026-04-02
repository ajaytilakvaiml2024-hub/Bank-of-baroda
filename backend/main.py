from fastapi import FastAPI, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import jwt
import datetime
from typing import Optional

app = FastAPI(title="Voice Banking API")

# Setup CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

SECRET_KEY = "super-secret-key-for-prototype"

# Mock DB
accounts = {
    "user123": {"name": "Elderly User", "balance": 5000.0}
}
contacts = {
    "ravi": {"id": "ravi", "name": "Ravi", "account_no": "123456789"},
    "simran": {"id": "simran", "name": "Simran", "account_no": "987654321"}
}

class TransactionRequest(BaseModel):
    amount: float
    recipient: str

class VerifyRequest(BaseModel):
    token: str
    pin: Optional[str] = None

def generate_task_token(task_type: str, details: dict):
    payload = {
        "task": task_type,
        "details": details,
        "exp": datetime.datetime.utcnow() + datetime.timedelta(minutes=2)
    }
    return jwt.encode(payload, SECRET_KEY, algorithm="HS256")

def verify_token(token: str):
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
        return payload
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Session expired for security reasons.")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid session token.")

@app.get("/")
def read_root():
    return {"message": "Banking API Active"}

@app.get("/api/balance")
def get_balance():
    return {
        "balance": accounts["user123"]["balance"],
        "audio_prompt": f"Your current balance is {accounts['user123']['balance']} rupees."
    }

class TranscriptionData(BaseModel):
    text: str

@app.post("/api/intent/parse")
def parse_intent(data: TranscriptionData):
    # Mock intent parsing logic (could use an LLM in production)
    text = data.text.lower()
    
    if "balance" in text or "how much" in text:
        return {"intent": "CHECK_BALANCE"}
    elif "send" in text or "transfer" in text or "pay" in text:
        words = text.split()
        amount = 0
        for word in words:
            if word.isdigit():
                amount = float(word)
                
        # Attempt to find contact
        recipient = None
        for name in contacts.keys():
            if name in text:
                recipient = name
                break
                
        if amount > 0 and recipient:
            return {
                "intent": "TRANSFER_FUNDS",
                "details": {
                    "amount": amount,
                    "recipient": recipient
                }
            }
        else:
             return {"intent": "INCOMPLETE", "message": "I didn't catch the amount or person. Could you please say how much and to whom?"}
    else:
        return {"intent": "UNKNOWN", "message": "I didn't understand that. You can ask to check your balance, or send money to someone."}

@app.post("/api/transaction/init")
def init_transaction(req: TransactionRequest):
    # Fraud rule: limits
    if req.amount > 10000:
        return {
            "status": "blocked", 
            "message": "Transaction exceeds safety limits.", 
            "audio_prompt": "This amount is too large. For your safety, we need to notify a family member to approve this transfer."
        }
    
    if req.recipient.lower() not in contacts:
        return {
            "status": "error", 
            "message": "Recipient not found.", 
            "audio_prompt": "I couldn't find that person in your contacts list."
        }

    # Generate a task-scoped session token
    token = generate_task_token("TRANSFER_FUNDS", {"amount": req.amount, "recipient": req.recipient.lower()})
    
    return {
        "status": "pending_confirmation", 
        "token": token,
        "audio_prompt": f"You want to send {int(req.amount)} rupees to {req.recipient.capitalize()}. Is that correct? Say 'Yes' to confirm."
    }

@app.post("/api/transaction/execute")
def execute_transaction(req: VerifyRequest):
    payload = verify_token(req.token)
    
    if payload.get("task") != "TRANSFER_FUNDS":
        raise HTTPException(status_code=400, detail="Invalid task token.")
        
    amount = payload["details"]["amount"]
    recipient = payload["details"]["recipient"]
    
    user_id = "user123"
    if accounts[user_id]["balance"] < amount:
        return {
            "status": "error", 
            "message": "Insufficient balance.", 
            "audio_prompt": "You do not have enough funds to complete this transfer."
        }
        
    accounts[user_id]["balance"] -= amount
    
    # Task completion implies termination of scope.
    return {
        "status": "success", 
        "message": f"Successfully sent {amount} to {recipient.capitalize()}.",
        "new_balance": accounts[user_id]["balance"],
        "audio_prompt": f"Success. {int(amount)} rupees have been sent to {recipient.capitalize()} safely. Do you need anything else?"
    }
