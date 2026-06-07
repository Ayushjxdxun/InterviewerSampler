import e from "express";
import AsyncHandler from "express-async-handler";
import {OAuth2Client} from "google-auth-library";
import jwt from "jsonwebtoken";

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const generateToken = (id) => {
    return jwt.sign(
        { id },
        process.env.JWT_SECRET,
        {
            expiresIn: "1d",
        }
    );
};

const registerUser = asyncHandler(async (req, res) => {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
        res.status(400);
        throw new Error("Please add all fields");
    }

    const userExists = await User.findOne({ email });

    if (userExists) {
        res.status(400);
        throw new Error("User already exists");
    }

    const user = await User.create({
        name,
        email,
        password,
    });

    if (user) {
        res.status(201).json({
            _id: user._id,
            name: user.name,
            email: user.email,
            token: generateToken(user._id),
        });
    } else {
        res.status(400);
        throw new Error("Invalid user data");
    }
});

const LoginUser = asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        res.status(400);
        throw new Error("Please add all fields");
    }

    const user = await User.findOne({ email });

    if (user && (await user.matchPassword(password))) {
        res.json({
            _id: user._id,
            name: user.name,
            email: user.email,
            preferredRole: user.preferredRole,
            token: generateToken(user._id),
        });
    } else {
        res.status(401);
        throw new Error("Invalid email or password");
    }
});

const googleLogin = asyncHandler(async (req, res) => {
    const { tokenId } = req.body;

    const ticket = await client.verifyIdToken({
        idToken: tokenId,
        audience: process.env.GOOGLE_CLIENT_ID,
    });
    const{ email_verified,email,name,sub:googleId } = ticket.getPayload();
    if(!email_verified) {
        res.status(401);
        throw new Error("Google account not verified");
    }
        let user = await User.findOne({ email });
        if (user) {
            if(!user.googleId) {
                user.googleId = googleId;
                await user.save();
            }
        } else {
            user = await User.create({
                name,
                email,
                googleId,
                password: null,
            });
                res.status(201).json({
                    _id: user._id,
                    name: user.name,
                    email: user.email,
                    preferredRole: user.preferredRole,
                    token: generateToken(user._id),
                });
            
        }
});

    const getUserProfile = asyncHandler(async (req, res) => {
        if(!req.user) {
            res.status(404);
            throw new Error("User not found");
        }
        res.json({
            _id: req.user._id,
            name: req.user.name,
            email: req.user.email,
            preferredRole: req.user.preferredRole,
        });
    });

    export{
        registerUser,
        LoginUser,
        googleLogin,
        getUserProfile
    }