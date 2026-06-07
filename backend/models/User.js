import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const userSchema = mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
        },
        email: {
            type: String,
            required: true,
            unique: true,
            trim:true,
        },
        password: {
            type: String,
            required:function () {
                return !this.googleId
            },
            trim:true
        },
    googleId: {
        type: String,
        unique: true,
        sparse: true,
    },
    preferredRole   : {
        type: String,
        default:"MERN Stack Developer",
    },
},
    {
        timestamps: true,
    }
);

userSchema.pre("save", async function (next) {
    if (!this.isModified("password")) {
        next();
    }
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
});

userSchema.methods.matchPassword = async function (enteredpassword) {
    if(!this.password) {
        return false;
    }
    return await bcrypt.compare(enteredpassword, this.password);
};

const User = mongoose.model("User", userSchema);

export default User;