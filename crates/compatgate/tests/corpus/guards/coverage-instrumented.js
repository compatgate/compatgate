// the_last_expression_of_a_sequence_is_tested_as_the_sequence: the output of
// swc-plugin-coverage-instrument 0.0.33 for a guarded call.
function share(d) { //~ none
    cov_12343553659005210970().f[0]++; //~ none
    cov_12343553659005210970().s[0]++; //~ none
    if ((cov_12343553659005210970().b[1][0]++, typeof navigator !== 'undefined') && (cov_12343553659005210970().b[1][1]++, navigator.share)) { //~ none
        cov_12343553659005210970().b[0][0]++; //~ none
        cov_12343553659005210970().s[1]++; //~ none
        navigator.share(d); //~ none
    } else { //~ none
        cov_12343553659005210970().b[0][1]++; //~ none
    }
}
